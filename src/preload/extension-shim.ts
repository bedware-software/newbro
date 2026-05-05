// Minimal polyfill for chrome.* APIs Electron 41 doesn't ship out of the
// box. Registered as a session preload (frame + service-worker) on every
// partition that hosts extensions; runs INSIDE the extension's own
// contexts so its scripts see a chrome.tabs.create that actually opens
// a tab in the host workspace, instead of throwing
//   "TypeError: I.tabs.create is not a function"
// the way Tampermonkey's Dashboard button does. The Electron-supplied
// chrome.tabs.query / .update / .reload / .sendMessage / .executeScript
// surface is left alone — we only fill in the gaps.
//
// Why a shim runs in BOTH context kinds:
//   - Frames (popup.html, options.html, regular extension pages) —
//     the popup script may call chrome.tabs.create directly.
//   - Service workers (MV3 background.js) — clicks in the popup are
//     usually round-tripped through chrome.runtime.sendMessage; the
//     listener in the SW is what actually calls chrome.tabs.create.
//     Tampermonkey 5.4.x is exactly this shape.
//
// Timing: this preload runs BEFORE any extension code, but Chromium
// installs the chrome.* binding on the same context lazily (chrome.tabs
// is a host object filled in C++). We can't synchronously patch a thing
// that doesn't exist yet, so we use a getter/setter trap on
// `globalThis.chrome` that re-applies our patches every time Chromium
// (re-)assigns the namespace. Polling / microtasks proved unreliable in
// the MV3 service-worker context — Tampermonkey's background script
// imports its own scripts very early and bound `chrome.tabs` to a local
// closure variable BEFORE any deferred patching could land.
//
// We can't `contextBridge`-expose anything here because the shim runs in
// the extension's own JS world (chrome.* lives there). ipcRenderer is
// available in both Electron preload contexts, so we use it directly.

import { ipcRenderer } from 'electron'

// Diagnostic: tell main we ran. The user-visible bug-report flow is "I
// installed Tampermonkey, clicked X, here's the log" — so loud
// confirmation of "shim loaded in SW for this extension" makes it easy
// to tell whether registerPreloadScript({ type: 'service-worker' })
// actually delivered the bytes.
function reportLoaded(stage: string): void {
  try {
    ipcRenderer.send('newbro-ext-shim-loaded', {
      stage,
      href: typeof location !== 'undefined' ? location?.href : null,
      hasChrome: typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined',
      hasTabs:
        typeof (globalThis as { chrome?: { tabs?: unknown } }).chrome?.tabs !== 'undefined',
      hasTabsCreate:
        typeof (globalThis as { chrome?: { tabs?: { create?: unknown } } }).chrome?.tabs
          ?.create === 'function',
    })
  } catch {
    /* ipcRenderer can be torn down in some contexts; best-effort */
  }
}

// Skip the shim outside extension contexts. Frames load with location.protocol
// available; service workers load with self.location populated to the
// extension's own URL. Either way, "is this a chrome-extension:// context"
// is the gate we want.
const proto = (() => {
  try {
    if (typeof location !== 'undefined' && location?.protocol) return location.protocol
  } catch { /* ignore */ }
  try {
    const sw = (globalThis as { location?: { protocol?: string } }).location
    if (sw?.protocol) return sw.protocol
  } catch { /* ignore */ }
  return ''
})()

if (proto === 'chrome-extension:') {
  reportLoaded('preload-start')
  install()
  reportLoaded('preload-end')
}

interface CreateProperties {
  url?: string
  active?: boolean
  windowId?: number
  index?: number
  pinned?: boolean
  openerTabId?: number
}

interface FakeTab {
  id: number
  index: number
  windowId: number
  active: boolean
  highlighted: boolean
  pinned: boolean
  url: string
  status: 'complete' | 'loading'
  incognito: boolean
}

function fakeTab(url: string, active: boolean): FakeTab {
  return {
    id: -1,
    index: 0,
    windowId: -1,
    active,
    highlighted: active,
    pinned: false,
    url,
    status: 'loading',
    incognito: false,
  }
}

function applyPatches(chrome: Record<string, unknown>): void {
  if (!chrome || typeof chrome !== 'object') return

  // chrome.tabs ── the gap we ACTUALLY hit. Tampermonkey calls .create
  // from background.js; Unhook calls it from popup.js. Electron 41
  // exposes a partial chrome.tabs (query / update / reload / sendMessage
  // / executeScript) but no `create`.
  const tabs = (chrome.tabs ?? (chrome.tabs = {})) as Record<string, unknown>
  if (typeof tabs.create !== 'function') {
    tabs.create = (props: CreateProperties, callback?: (tab: FakeTab) => void) => {
      const url = typeof props?.url === 'string' ? props.url : ''
      const active = props?.active !== false
      try { ipcRenderer.send('newbro-ext-open-tab', { url, active }) } catch { /* ignore */ }
      const tab = fakeTab(url, active)
      if (typeof callback === 'function') {
        Promise.resolve().then(() => callback(tab))
      }
      return Promise.resolve(tab)
    }
  }

  // chrome.windows.create ── extensions occasionally use this instead of
  // chrome.tabs.create, requesting a popup window. Treat the same as a
  // new tab — we don't have multi-window-per-extension UX yet and a tab
  // is the closest equivalent.
  const windows = (chrome.windows ?? (chrome.windows = {})) as Record<string, unknown>
  if (typeof windows.create !== 'function') {
    windows.create = (
      props: { url?: string | string[]; focused?: boolean },
      callback?: (win: { id: number; tabs: FakeTab[] }) => void
    ) => {
      const urls = Array.isArray(props?.url) ? props!.url : props?.url ? [props.url as string] : []
      for (const u of urls) {
        try { ipcRenderer.send('newbro-ext-open-tab', { url: u, active: props?.focused !== false }) } catch { /* ignore */ }
      }
      const win = { id: -1, tabs: urls.map((u) => fakeTab(u, true)) }
      if (typeof callback === 'function') Promise.resolve().then(() => callback(win))
      return Promise.resolve(win)
    }
  }

  // chrome.runtime.openOptionsPage ── built into real Chrome, missing
  // here. Tampermonkey, uBlock, and many others wire their "Open
  // settings" link to it. Look up the manifest's options page from the
  // extension's own URL via chrome.runtime.getManifest (which Electron
  // does provide) and route it through the same new-tab IPC.
  const runtime = (chrome.runtime ?? (chrome.runtime = {})) as Record<string, unknown>
  if (typeof runtime.openOptionsPage !== 'function') {
    runtime.openOptionsPage = (callback?: () => void) => {
      try {
        const m = typeof runtime.getManifest === 'function'
          ? (runtime.getManifest as () => Record<string, unknown>)()
          : {}
        const optionsPage =
          typeof m.options_page === 'string'
            ? m.options_page
            : (m.options_ui as { page?: string } | undefined)?.page
        if (typeof optionsPage === 'string' && optionsPage.length > 0 && typeof runtime.getURL === 'function') {
          const url = (runtime.getURL as (path: string) => string)(optionsPage)
          ipcRenderer.send('newbro-ext-open-tab', { url, active: true })
        }
      } catch { /* ignore */ }
      if (typeof callback === 'function') Promise.resolve().then(() => callback())
      return Promise.resolve()
    }
  }
}

function install(): void {
  const w = globalThis as unknown as { chrome?: Record<string, unknown> }

  // Patch whatever's already there now …
  if (w.chrome) applyPatches(w.chrome)

  // … AND keep patching every time Chromium replaces the chrome object.
  // The MV3 service worker observed in practice has Chromium initialise
  // chrome AFTER the preload returns — patches we wrote to a placeholder
  // {} get clobbered when Chromium assigns the real namespace. The trap
  // below re-applies our patches at every assignment point so the gap is
  // closed regardless of timing.
  let backing: Record<string, unknown> | undefined = w.chrome
  try {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      enumerable: true,
      get() { return backing },
      set(v: Record<string, unknown> | undefined) {
        backing = v
        if (v) applyPatches(v)
      },
    })
  } catch {
    // Some Chromium builds make `chrome` non-configurable on the worker
    // global; defineProperty throws in that case. Fall back to polling
    // for a short window so we still patch once Chromium is done
    // initialising. Six attempts × 1ms covers the common races; bail
    // out after that to avoid an infinite microtask churn.
    let tries = 0
    const tick = (): void => {
      if (w.chrome && typeof w.chrome === 'object') {
        applyPatches(w.chrome)
        return
      }
      if (tries++ < 6) Promise.resolve().then(tick)
    }
    tick()
  }
}

