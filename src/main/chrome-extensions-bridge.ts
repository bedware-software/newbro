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
