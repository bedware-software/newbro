// One ElectronChromeExtensions instance per partitioned session.
//
// The library provides Chrome extension API surface that Electron's stock
// extension support doesn't: chrome.tabs (full), chrome.action, chrome.windows,
// chrome.permissions, chrome.management, chrome.contextMenus, chrome.cookies,
// chrome.notifications, chrome.runtime.* messaging, plus the session-preload
// bookkeeping that wires extension contexts to all of the above. We keep our
// chrome.userScripts polyfill (sw-shim.ts) because the library doesn't
// implement it.
//
// Lifecycle: created lazily the first time a partition is touched in
// setupPartitionSession; tabs are registered/unregistered/selected as the
// renderer drives them through tab-views.ts. The library installs its own
// session preload via registerPreloadScript, which co-exists with our
// stealth preload.
//
// License: GPL-3.0 by default. Switch to 'Patron-License-2020-11-19'
// (paid via the maintainer's GitHub Sponsors) if Newbro ships closed-source.

import { BrowserWindow, type Session, type WebContents, type BaseWindow } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { log } from './log'

const instances = new Map<Session, ElectronChromeExtensions>()

/** True while we're inside our own ext.addTab / ext.selectTab call.
 *  The library auto-activates each newly-added tab (observeTab calls
 *  onActivated → store.setActiveTab → impl.selectTab callback), which
 *  cascades through every tab as the workspace restores — every tab
 *  becomes "active" in turn, the renderer cycles its URL bar through
 *  all of them, and the user sees lightning-fast tab cycling. We
 *  flip the flag while orchestrating so the library's spurious
 *  callback during that window is ignored; real callbacks (from
 *  chrome.tabs.update issued by an extension) come in after the flag
 *  is cleared and propagate to the renderer normally. */
let suppressLibraryCallback = false

export function suppressLibrarySelectTab<T>(work: () => T): T {
  const previous = suppressLibraryCallback
  suppressLibraryCallback = true
  try {
    return work()
  } finally {
    suppressLibraryCallback = previous
  }
}

export function isLibrarySelectTabSuppressed(): boolean {
  return suppressLibraryCallback
}

/** Initialise the extension API surface for a session. Idempotent —
 *  calling twice for the same session returns the existing instance. */
export function getOrCreateExtensions(
  ses: Session,
  callbacks: {
    /** chrome.tabs.create — open a tab with the given URL in the user's
     *  active workspace and return its webContents + window. */
    createTab(details: { url?: string; active?: boolean; windowId?: number }): Promise<[WebContents, BaseWindow]>
    /** chrome.tabs.update with active:true — switch focus to this tab. */
    selectTab(tab: WebContents, win: BaseWindow): void
    /** chrome.tabs.remove — close the tab. */
    removeTab(tab: WebContents, win: BaseWindow): void
  },
): ElectronChromeExtensions {
  const existing = instances.get(ses)
  if (existing) return existing
  const ext = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: callbacks.createTab,
    selectTab: callbacks.selectTab,
    removeTab: callbacks.removeTab,
    createWindow: async () => {
      // Newbro's "windows" don't map cleanly onto Chrome's windows.create
      // (we have a single workspace window per profile, not arbitrary
      // popouts). Return the most-recently-focused workspace window so
      // the call doesn't reject; downstream chrome.tabs.create lands a
      // tab inside it as if windows.create({tabs:[…]}) had been called.
      const focused = BrowserWindow.getFocusedWindow()
      const fallback = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      const target = focused && !focused.isDestroyed() ? focused : fallback
      if (!target) throw new Error('no live window for chrome.windows.create')
      return target
    },
    removeWindow: (win) => {
      try { win.close() } catch { /* ignore */ }
    },
    requestPermissions: async () => true,
    assignTabDetails: (details, wc) => {
      // The Electron WebContents.id is what the library uses for tab.id;
      // most fields are auto-filled. Only override URL/title here when
      // they're missing — this fires from inside chrome.tabs.query().
      try {
        if (!details.url) details.url = wc.getURL()
        if (!details.title) details.title = wc.getTitle()
      } catch { /* ignore */ }
    },
  })
  instances.set(ses, ext)
  log.info('extensions: ElectronChromeExtensions ready', { partition: '(by-session)' })
  // Listen for popups created via chrome.action.openPopup or via the
  // library's <browser-action-list>. We don't use either path
  // (Newbro has its own toolbar icons that drive popups via IPC), but
  // the listener gives us a place to add diagnostics if the library
  // ever decides to open a popup on its own.
  ext.on('browser-action-popup-created', (popup) => {
    log.info('extensions: library popup created', {
      extensionId: (popup as { extensionId?: string }).extensionId,
    })
  })
  return ext
}

export function getExtensionsFor(ses: Session): ElectronChromeExtensions | undefined {
  return instances.get(ses) ?? ElectronChromeExtensions.fromSession(ses)
}

/** Per-extension dynamic browser-action state surfaced to the renderer.
 *  Mirrors the shape of BrowserActionAPI.getState() entries plus an
 *  iconModified timestamp to bust the icon cache when chrome.action.setIcon
 *  fires from the SW. */
export interface BrowserActionEntry {
  id: string
  title?: string
  popup?: string
  text?: string
  color?: string
  iconModified?: number
  /** Per-tab overrides — same shape as the top-level fields. */
  tabs: Record<number, {
    title?: string
    popup?: string
    text?: string
    color?: string
    iconModified?: number
  }>
}

export interface BrowserActionState {
  activeTabId?: number
  actions: BrowserActionEntry[]
}

/** Read the BrowserAction state for a session and shape it for the renderer.
 *  We can't use the library's getState() directly because it strips the
 *  iconModified field — and we need that to drive the crx:// cache buster
 *  so the toolbar icon refreshes when the extension calls setIcon. */
export function getBrowserActionStateForSession(ses: Session): BrowserActionState {
  const ext = getExtensionsFor(ses)
  if (!ext) return { actions: [] }
  // The library's actionMap is private. The `as any` cast is the cost of
  // not being able to subscribe to icon updates through any public API.
  type RawAction = {
    title?: string
    popup?: string
    text?: string
    color?: string
    iconModified?: number
    tabs: Record<number, {
      title?: string
      popup?: string
      text?: string
      color?: string
      iconModified?: number
    }>
  }
  const internal = (ext as unknown as {
    api?: { browserAction?: { actionMap?: Map<string, RawAction>; getState?: () => { activeTabId?: number } } }
  }).api?.browserAction
  if (!internal?.actionMap) return { actions: [] }
  const actions: BrowserActionEntry[] = []
  for (const [id, raw] of internal.actionMap.entries()) {
    const tabs: Record<number, BrowserActionEntry['tabs'][number]> = {}
    for (const [tabId, t] of Object.entries(raw.tabs ?? {})) {
      tabs[Number(tabId)] = {
        title: t.title,
        popup: t.popup,
        text: t.text,
        color: t.color,
        iconModified: t.iconModified,
      }
    }
    actions.push({
      id,
      title: raw.title,
      popup: raw.popup,
      text: raw.text,
      color: raw.color,
      iconModified: raw.iconModified,
      tabs,
    })
  }
  const activeTabId = internal.getState?.().activeTabId
  return { activeTabId, actions }
}

/** Subscribe to browser-action updates for the given session. The library
 *  emits these whenever the actionMap mutates (chrome.action.setIcon /
 *  setBadgeText / setTitle / setPopup, plus tab-removed cleanups and the
 *  active-tab-changed event). We piggyback by injecting a fake observer
 *  into BrowserActionAPI's private observers Set — the library calls
 *  observer.send('browserAction.update') on each mutation, and we forward
 *  that to the supplied callback after pulling the latest state. */
export function subscribeBrowserActionUpdates(
  ses: Session,
  callback: (state: BrowserActionState) => void,
): () => void {
  const ext = getExtensionsFor(ses)
  if (!ext) return () => undefined
  const observers = (ext as unknown as {
    api?: { browserAction?: { observers?: Set<unknown> } }
  }).api?.browserAction?.observers
  if (!observers) return () => undefined
  const fakeObserver = {
    isDestroyed: () => false,
    send: (channel: string) => {
      if (channel !== 'browserAction.update') return
      try {
        callback(getBrowserActionStateForSession(ses))
      } catch (err) {
        log.warn('extensions: browser-action callback threw', String(err))
      }
    },
    once: () => undefined,
  }
  observers.add(fakeObserver)
  // Also fire one immediately so the renderer picks up whatever the
  // library has already discovered from manifest defaults.
  try { callback(getBrowserActionStateForSession(ses)) } catch { /* ignore */ }
  return () => { observers.delete(fakeObserver) }
}
