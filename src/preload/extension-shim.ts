// Frame-context preload that runs in chrome-extension:// frames
// (popup.html, options.html, etc.). After the electron-chrome-extensions
// integration landed, the heavy lifting (chrome.tabs, chrome.permissions,
// chrome.management, chrome.runtime messaging, chrome.action, chrome.windows)
// is provided by the library's own preload — we just provide a tiny
// fallback for chrome.userScripts (the library doesn't implement it) and
// a diagnostic ping so we can confirm the preload ran.
//
// We DO NOT override anything the library installs. Conditional checks
// only — `if (typeof X !== 'function') X = …`.

import { ipcRenderer } from 'electron'

function reportLoaded(stage: string): void {
  try {
    ipcRenderer.send('newbro-ext-shim-loaded', {
      stage,
      href: typeof location !== 'undefined' ? location?.href : null,
      hasChrome: typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined',
      hasUserScripts:
        typeof (globalThis as { chrome?: { userScripts?: unknown } }).chrome?.userScripts !== 'undefined',
    })
  } catch { /* ipcRenderer may be torn down */ }
}

// Skip outside extension contexts.
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

function install(): void {
  const w = globalThis as unknown as { chrome?: Record<string, unknown> }

  if (w.chrome) applyPatches(w.chrome)

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

function applyPatches(chrome: Record<string, unknown>): void {
  if (!chrome || typeof chrome !== 'object') return

  // chrome.userScripts ── stubbed so popup-side detection
  // (Tampermonkey reads chrome.userScripts to decide whether to show
  // the "developer mode required" warning) sees a real-looking
  // namespace. Persistence and injection live in the SW context's
  // shim and main's userscripts registry; this frame-side stub just
  // answers calls with empty results so the popup doesn't blow up if
  // it queries here.
  const userScripts = (chrome.userScripts ?? (chrome.userScripts = {})) as Record<string, unknown>
  const noopAsync = (_args?: unknown, callback?: (...a: unknown[]) => void) => {
    if (typeof callback === 'function') Promise.resolve().then(() => callback())
    return Promise.resolve()
  }
  if (typeof userScripts.register !== 'function') userScripts.register = noopAsync
  if (typeof userScripts.unregister !== 'function') userScripts.unregister = noopAsync
  if (typeof userScripts.update !== 'function') userScripts.update = noopAsync
  if (typeof userScripts.getScripts !== 'function') {
    userScripts.getScripts = (_filter?: unknown, callback?: (s: unknown[]) => void) => {
      if (typeof callback === 'function') Promise.resolve().then(() => callback([]))
      return Promise.resolve([])
    }
  }
  if (typeof userScripts.configureWorld !== 'function') userScripts.configureWorld = noopAsync
  if (typeof userScripts.getWorldConfigurations !== 'function') {
    userScripts.getWorldConfigurations = (callback?: (s: unknown[]) => void) => {
      if (typeof callback === 'function') Promise.resolve().then(() => callback([]))
      return Promise.resolve([])
    }
  }
  if (typeof userScripts.resetWorldConfiguration !== 'function') {
    userScripts.resetWorldConfiguration = noopAsync
  }
}
