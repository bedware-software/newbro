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
// We can't `contextBridge`-expose anything here because the shim runs in
// the extension's own JS world (chrome.* lives there). ipcRenderer is
// available in both Electron preload contexts, so we use it directly.

import { ipcRenderer } from 'electron'

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
  install()
}

interface CreateProperties {
  url?: string
  active?: boolean
  windowId?: number
  index?: number
  pinned?: boolean
  openerTabId?: number
}

interface UpdateProperties {
  url?: string
  active?: boolean
  highlighted?: boolean
  pinned?: boolean
  muted?: boolean
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

function install(): void {
  const w = globalThis as unknown as { chrome?: Record<string, unknown> }
  const chrome = (w.chrome ?? (w.chrome = {})) as Record<string, unknown>

  // chrome.tabs ── the gap we ACTUALLY hit. Tampermonkey calls .create
  // from background.js; Unhook calls it from popup.js. Electron 41
  // exposes a partial chrome.tabs (query / update / reload / sendMessage
  // / executeScript) but no `create`.
  const tabs = (chrome.tabs ?? (chrome.tabs = {})) as Record<string, unknown>

  if (typeof tabs.create !== 'function') {
    tabs.create = (props: CreateProperties, callback?: (tab: FakeTab) => void) => {
      const url = typeof props?.url === 'string' ? props.url : ''
      const active = props?.active !== false
      ipcRenderer.send('newbro-ext-open-tab', { url, active })
      const tab = fakeTab(url, active)
      if (typeof callback === 'function') {
        // Asynchronous to match the real chrome.tabs.create contract —
        // some callers depend on the callback firing in a microtask
        // rather than synchronously.
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
        ipcRenderer.send('newbro-ext-open-tab', { url: u, active: props?.focused !== false })
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
