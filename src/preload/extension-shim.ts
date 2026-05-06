// Frame-context preload that runs in chrome-extension:// frames
// (popup.html, options.html, etc.). After the electron-chrome-extensions
// integration landed, the heavy lifting (chrome.tabs, chrome.permissions,
// chrome.management, chrome.runtime messaging, chrome.action, chrome.windows)
// is provided by the library's own preload.
//
// We provide:
// - chrome.userScripts: tiny no-op fallback (library doesn't implement
//   it; popup-side detection just needs the namespace to exist)
// - chrome.management.getSelf: wrap-and-decorate to spoof
//   installType='development' so Tampermonkey's "Please enable
//   developer mode" banner goes away. Same fix we apply in the SW
//   shim — the popup makes its OWN getSelf call, so both contexts
//   need to agree.
// - A diagnostic ping so we can confirm the preload ran.

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

  // chrome.management.getSelf — wrap to overlay installType='development'.
  // Tampermonkey reads this in the popup context to decide whether to
  // show the "Please enable developer mode" banner. Without this, even
  // with the SW-side override in place, the popup's own getSelf call
  // returns whatever Electron stock provides (probably installType='normal')
  // and the banner shows.
  const management = (chrome.management ?? (chrome.management = {})) as Record<string, unknown>
  const origGetSelf =
    typeof management.getSelf === 'function'
      ? (management.getSelf as (cb?: (info: unknown) => void) => Promise<unknown> | void).bind(management)
      : null
  const decorate = (info: unknown): Record<string, unknown> => {
    const out = (info && typeof info === 'object') ? { ...(info as Record<string, unknown>) } : {}
    out.installType = 'development'
    if (!Array.isArray(out.hostPermissions) || (out.hostPermissions as string[]).length === 0) {
      out.hostPermissions = ['<all_urls>']
    }
    out.enabled = true
    out.mayDisable = true
    return out
  }
  management.getSelf = (callback?: (info: unknown) => void) => {
    if (origGetSelf) {
      try {
        const maybe = origGetSelf((info: unknown) => {
          if (typeof callback === 'function') {
            Promise.resolve().then(() => callback(decorate(info)))
          }
        })
        if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
          return (maybe as Promise<unknown>).then(decorate, () => decorate({}))
        }
      } catch {
        /* fall through to synthetic */
      }
    }
    const synth = decorate({})
    if (typeof callback === 'function') Promise.resolve().then(() => callback(synth))
    return Promise.resolve(synth)
  }
}
