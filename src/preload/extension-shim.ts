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

import { contextBridge, ipcRenderer } from 'electron'

// True when this preload runs in a service-worker preload realm
// (Electron 35+). `process.type` is exposed in preload realms; guarded
// because frame preloads on very old Electron may lack it.
const IS_SW_REALM = (() => {
  try {
    return (process as unknown as { type?: string })?.type === 'service-worker'
  } catch {
    return false
  }
})()

function reportLoaded(stage: string): void {
  try {
    ipcRenderer.send('newbro-ext-shim-loaded', {
      stage,
      href: typeof location !== 'undefined' ? location?.href : null,
      hasChrome: typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined',
      hasUserScripts:
        typeof (globalThis as { chrome?: { userScripts?: unknown } }).chrome?.userScripts !== 'undefined',
    })
  } catch (err) {
    // ipcRenderer.send during page teardown can throw; console.error
    // here surfaces via the page's existing console-message → main pipe.
    try { console.error('[newbro-ext-shim] reportLoaded ipc.send failed:', err) }
    catch { /* console torn down too — last resort */ }
  }
}

// Skip outside extension contexts.
const proto = (() => {
  try {
    if (typeof location !== 'undefined' && location?.protocol) return location.protocol
  } catch (err) {
    try { console.error('[newbro-ext-shim] location.protocol read threw:', err) }
    catch { /* nothing more we can do */ }
  }
  try {
    const sw = (globalThis as { location?: { protocol?: string } }).location
    if (sw?.protocol) return sw.protocol
  } catch (err) {
    try { console.error('[newbro-ext-shim] sw location.protocol read threw:', err) }
    catch { /* nothing more we can do */ }
  }
  return ''
})()

if (IS_SW_REALM) {
  // Service-worker preload realm. CRITICAL: `location` is undefined
  // here, so the frame-style `location.protocol` guard below can never
  // match — that guard silently disabling this file in SW realms is
  // exactly what the old "SW preload doesn't fire in Electron 41" bug
  // actually was. Realm detection must use process.type.
  installMainWorldApis((channel, payload) => ipcRenderer.invoke('newbro-sw', channel, payload))
  initSwRealm()
} else if (proto === 'chrome-extension:') {
  reportLoaded('preload-start')
  installMainWorldApis((channel, payload) => ipcRenderer.invoke('newbro-ext-frame', channel, payload))
  // Wrap install() in try-catch — a thrown error in our shim would
  // bubble up out of the preload and have prevented the page's own
  // scripts from running. Better to skip the polyfill than to break
  // the popup with a white screen.
  try {
    install()
  } catch (err) {
    try {
      ipcRenderer.send('newbro-ext-shim-trace', {
        kind: 'install-threw',
        href: typeof location !== 'undefined' ? location?.href : null,
        err: String(err),
      })
    } catch (sendErr) {
      try { console.error('[newbro-ext-shim] install threw, ipc.send also failed:', err, sendErr) }
      catch { /* nothing more we can do */ }
    }
  }
  reportLoaded('preload-end')
}

// ── Main-world chrome.* polyfills (frames + service workers) ──
//
// Electron ships neither chrome.sidePanel nor chrome.tabGroups. Both
// must exist BEFORE the extension's own code runs: Claude's modules
// read chrome.tabGroups.Color in a class static initializer at load
// time (a missing namespace kills the whole module graph, worker and
// side panel page alike), and they feature-test chrome.sidePanel.
// Preloads run before page/worker scripts, and executeInMainWorld is
// synchronous — the same mechanism electron-chrome-extensions uses for
// its own chrome.* namespaces. `invoke` reaches main over the realm's
// transport (ServiceWorkerMain.ipc or ipcMain) and resolves to
// { ok, data } | { ok: false, error }.
function installMainWorldApis(invoke: (channel: string, payload: unknown) => Promise<unknown>): void {
  const cb = contextBridge as unknown as {
    executeInMainWorld?: (spec: { func: (...a: never[]) => void; args?: unknown[] }) => void
  }
  if (typeof cb.executeInMainWorld !== 'function') return
  try {
    cb.executeInMainWorld({ func: mainWorldApis as (...a: never[]) => void, args: [invoke] })
  } catch (err) {
    try { console.error('[newbro-ext-shim] main-world API install failed:', err) }
    catch { /* console torn down */ }
  }
}

// SERIALIZED into the main world — must stay self-contained (no
// references to anything outside its own body).
function mainWorldApis(invoke: (channel: string, payload: unknown) => Promise<unknown>): void {
  type Listener = (...args: unknown[]) => void
  type Callback = ((value?: unknown) => void) | undefined
  const g = globalThis as unknown as {
    location?: { protocol?: string }
    chrome?: Record<string, unknown> & { runtime?: { getManifest?: () => { permissions?: unknown } } }
  }
  try {
    if (!g.location || g.location.protocol !== 'chrome-extension:') return
  } catch {
    return
  }
  // Proof for the worker shim that this realm's preload ran at all —
  // Electron skips SW preloads in unsandboxed renderer processes, and
  // sw-shim.ts reports workers that land in one.
  try {
    Object.defineProperty(globalThis, '__newbroPreloadRan', { value: true })
  } catch {
    /* already defined */
  }
  const chrome = g.chrome
  if (!chrome || typeof chrome !== 'object') return
  let permissions: unknown[] = []
  try {
    const p = chrome.runtime?.getManifest?.()?.permissions
    if (Array.isArray(p)) permissions = p
  } catch {
    /* no manifest access — treat as no permissions */
  }

  const makeEvent = (): Record<string, unknown> => {
    const listeners: Listener[] = []
    return {
      addListener: (fn: Listener) => { if (typeof fn === 'function' && !listeners.includes(fn)) listeners.push(fn) },
      removeListener: (fn: Listener) => {
        const i = listeners.indexOf(fn)
        if (i !== -1) listeners.splice(i, 1)
      },
      hasListener: (fn: Listener) => listeners.includes(fn),
      hasListeners: () => listeners.length > 0,
    }
  }
  // Chrome APIs return a Promise unless a trailing callback is passed.
  const settle = (p: Promise<unknown>, done: Callback): Promise<unknown> | undefined => {
    if (typeof done !== 'function') return p
    p.then((v) => done(v), () => done(undefined))
    return undefined
  }
  const define = (name: string, value: unknown): void => {
    if (chrome[name] !== undefined) return
    try {
      Object.defineProperty(chrome, name, { value, enumerable: true, configurable: true, writable: true })
    } catch {
      /* chrome pinned non-extensible — nothing we can do */
    }
  }

  // The SW bridge stringifies errors ("Error: …"); hand the extension
  // Chrome-shaped messages.
  const callMain = (channel: string, op: string, args: unknown): Promise<unknown> =>
    invoke(channel, { op, args }).then((r) => {
      const res = r as { ok?: boolean; data?: unknown; error?: string } | undefined
      if (res && res.ok) return res.data
      throw new Error(String((res && res.error) || `${channel}.${op} failed`).replace(/^Error: /, ''))
    })

  if (permissions.includes('sidePanel')) {
    const call = (op: string, args: unknown): Promise<unknown> => callMain('sidepanel', op, args)
    define('sidePanel', {
      setOptions: (options: unknown, done?: Callback) => settle(call('setOptions', options), done),
      getOptions: (options: unknown, done?: Callback) => settle(call('getOptions', options), done),
      setPanelBehavior: (behavior: unknown, done?: Callback) => settle(call('setPanelBehavior', behavior), done),
      getPanelBehavior: (done?: Callback) => settle(call('getPanelBehavior', null), done),
      open: (options: unknown, done?: Callback) => settle(call('open', options), done),
      close: (options: unknown, done?: Callback) => settle(call('close', options), done),
      getLayout: (done?: Callback) => settle(Promise.resolve({ side: 'right' }), done),
      onOpened: makeEvent(),
      onClosed: makeEvent(),
    })
  }

  // OAuth via chrome.identity.launchWebAuthFlow (main/extensions/
  // identity.ts). Google account tokens (getAuthToken) don't exist here.
  if (permissions.includes('identity')) {
    const extensionId = (chrome.runtime as { id?: string } | undefined)?.id ?? ''
    define('identity', {
      getRedirectURL: (path?: string) =>
        `https://${extensionId}.chromiumapp.org/${String(path ?? '').replace(/^\/+/, '')}`,
      launchWebAuthFlow: (details: unknown, done?: Callback) =>
        settle(callMain('identity', 'launchWebAuthFlow', details), done),
      getAuthToken: (...args: unknown[]) => {
        const last = args[args.length - 1]
        return settle(
          Promise.reject(new Error('OAuth2 not granted or revoked.')),
          typeof last === 'function' ? (last as Callback) : undefined,
        )
      },
      removeCachedAuthToken: (_details: unknown, done?: Callback) => settle(Promise.resolve(), done),
      clearAllCachedAuthTokens: (done?: Callback) => settle(Promise.resolve(), done),
      getProfileUserInfo: (...args: unknown[]) => {
        const last = args[args.length - 1]
        return settle(
          Promise.resolve({ email: '', id: '' }),
          typeof last === 'function' ? (last as Callback) : undefined,
        )
      },
      onSignInChanged: makeEvent(),
    })
  }

  // No chrome.debugger yet. Claude wires chrome.debugger.onEvent at module
  // load; give it the namespace and fail the calls that would need a
  // real CDP session. Callback position varies (sendCommand's params are
  // optional), so take the trailing function, if any.
  if (permissions.includes('debugger')) {
    const unsupported = (args: unknown[]): Promise<unknown> | undefined => {
      const last = args[args.length - 1]
      return settle(
        Promise.reject(new Error('chrome.debugger is not available in Newbro.')),
        typeof last === 'function' ? (last as Callback) : undefined,
      )
    }
    define('debugger', {
      attach: (...args: unknown[]) => unsupported(args),
      detach: (...args: unknown[]) => unsupported(args),
      sendCommand: (...args: unknown[]) => unsupported(args),
      getTargets: (done?: Callback) => settle(Promise.resolve([]), done),
      onEvent: makeEvent(),
      onDetach: makeEvent(),
    })
  }

  // Newbro has no tab groups: report none, refuse to edit any. Enough
  // for extensions that only decorate their own groups.
  if (permissions.includes('tabGroups')) {
    const noGroup = (groupId: unknown): Promise<unknown> =>
      Promise.reject(new Error(`No group with id: ${String(groupId)}.`))
    define('tabGroups', {
      TAB_GROUP_ID_NONE: -1,
      Color: Object.freeze({
        GREY: 'grey',
        BLUE: 'blue',
        RED: 'red',
        YELLOW: 'yellow',
        GREEN: 'green',
        PINK: 'pink',
        PURPLE: 'purple',
        CYAN: 'cyan',
        ORANGE: 'orange',
      }),
      get: (groupId: unknown, done?: Callback) => settle(noGroup(groupId), done),
      query: (_info: unknown, done?: Callback) => settle(Promise.resolve([]), done),
      update: (groupId: unknown, _props: unknown, done?: Callback) => settle(noGroup(groupId), done),
      move: (groupId: unknown, _props: unknown, done?: Callback) => settle(noGroup(groupId), done),
      onCreated: makeEvent(),
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onMoved: makeEvent(),
    })
  }
}

// ── Service-worker realm: __newbroIpc transport facade ──
//
// Exposes into the SW MAIN world:
//   __newbroIpc.invoke(channel, payload) → Promise<{ok,data|error}>
//   __newbroIpc.notify(channel, payload) → void  (fire-and-forget)
//   __newbroIpc.on(channel, cb)          → void  (main-pushed events)
// The polyfill shim (sw-shim.ts) prefers this facade over the legacy
// loopback-HTTP transport when present.
//
// Order matters: the event listener + buffers are registered BEFORE
// 'hello' is invoked, because main flips the worker to push-ready on
// hello — any push arriving before the shim's __newbroIpc.on()
// subscription lands in the per-channel buffer and is flushed to the
// first subscriber.
function initSwRealm(): void {
  // Preload-side registry of main-world event callbacks. Callbacks are
  // contextBridge-proxied functions; calling them crosses back into the
  // SW main world.
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>()
  // Pushes that arrived before the SW shim subscribed. Bounded so a
  // channel nobody ever subscribes to can't grow without limit.
  const MAX_BUFFERED = 200
  const bufferedEvents = new Map<string, unknown[]>()

  ipcRenderer.on('newbro-sw-event', (_event, channel: unknown, payload: unknown) => {
    const ch = String(channel)
    const cbs = eventListeners.get(ch)
    if (!cbs || cbs.length === 0) {
      const buf = bufferedEvents.get(ch) ?? []
      if (buf.length >= MAX_BUFFERED) {
        console.error('[newbro-ext-shim] sw-event buffer overflow, dropping oldest:', ch)
        buf.shift()
      }
      buf.push(payload)
      bufferedEvents.set(ch, buf)
      return
    }
    for (const cb of cbs) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[newbro-ext-shim] sw-event listener threw:', ch, err)
      }
    }
  })

  const facade = {
    invoke: (channel: string, payload: unknown): Promise<unknown> =>
      ipcRenderer.invoke('newbro-sw', String(channel), payload),
    notify: (channel: string, payload: unknown): void => {
      ipcRenderer.send('newbro-sw-notify', String(channel), payload)
    },
    on: (channel: string, cb: (payload: unknown) => void): void => {
      const ch = String(channel)
      const list = eventListeners.get(ch) ?? []
      list.push(cb)
      eventListeners.set(ch, list)
      const buf = bufferedEvents.get(ch)
      if (buf && buf.length > 0) {
        bufferedEvents.delete(ch)
        for (const payload of buf) {
          try {
            cb(payload)
          } catch (err) {
            console.error('[newbro-ext-shim] sw-event buffered replay threw:', ch, err)
          }
        }
      }
    },
  }

  // ipcRenderer here talks to ServiceWorkerMain.ipc (sw-bridge.ts),
  // NOT the global ipcMain. The bridge only registers handlers on
  // chrome-extension:// workers, so a successful 'hello' doubles as
  // the extension-context check: web-site service workers get a
  // rejection and we install nothing into them.
  ipcRenderer
    .invoke('newbro-sw', 'hello', { realm: 'service-worker' })
    .then((ack) => {
      const ok = !!(ack as { ok?: boolean } | undefined)?.ok
      if (!ok) {
        // Reached the bridge but got a refusal — log loudly, this is
        // not an expected state for an extension worker.
        console.error('[newbro-ext-shim] sw hello refused:', JSON.stringify(ack))
        return
      }
      try {
        const cb = contextBridge as unknown as {
          executeInMainWorld?: (spec: { func: (...a: never[]) => void; args?: unknown[] }) => void
        }
        if (typeof cb.executeInMainWorld === 'function') {
          cb.executeInMainWorld({
            func: ((invoke: unknown, notify: unknown, on: unknown) => {
              ;(globalThis as Record<string, unknown>).__newbroIpc = Object.freeze({
                invoke,
                notify,
                on,
              })
            }) as (...a: never[]) => void,
            args: [facade.invoke, facade.notify, facade.on],
          })
          // Confirm facade installation on the main side (shows up in
          // the log next to the worker's 'hello').
          ipcRenderer.send('newbro-sw-notify', 'log', { facade: 'installed' })
        } else {
          // Electron without executeInMainWorld can't reach the SW main
          // world from a preload realm — the legacy HTTP transport stays
          // in charge. Loud log so this never silently degrades.
          console.error(
            '[newbro-ext-shim] contextBridge.executeInMainWorld missing — __newbroIpc not installed',
          )
        }
      } catch (err) {
        console.error('[newbro-ext-shim] __newbroIpc install failed:', err)
      }
    })
    .catch(() => {
      // Expected for non-extension (web site) service workers: the
      // bridge registers no handler there, so the invoke rejects.
      // Deliberately quiet — this fires for every site SW on the
      // partition.
    })
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
  // show the "Please enable developer mode" banner. Single-path
  // implementation: ALWAYS return a Promise. If a callback is passed,
  // forward the resolved value to it once. Either resolve via
  // Electron's Promise-style getSelf, or wrap a callback-style getSelf
  // in a Promise, or synthesise from runtime.getManifest. No dual-
  // callback path — V10's two-codepath wrapper called the user's
  // callback twice in the callback-style case which crashed
  // Tampermonkey's popup (white screen).
  const management = (chrome.management ?? (chrome.management = {})) as Record<string, unknown>
  const rawGetSelf =
    typeof management.getSelf === 'function'
      ? (management.getSelf as (cb?: (info: unknown) => void) => Promise<unknown> | void).bind(management)
      : null
  const decorate = (info: unknown): Record<string, unknown> => {
    const runtime = (chrome.runtime ?? {}) as Record<string, unknown>
    const m =
      typeof runtime.getManifest === 'function'
        ? (runtime.getManifest as () => Record<string, unknown>)()
        : ({} as Record<string, unknown>)
    const out = info && typeof info === 'object' ? { ...(info as Record<string, unknown>) } : {}
    if (!out.id && typeof runtime.id === 'string') out.id = runtime.id
    if (!out.name && typeof m.name === 'string') out.name = m.name as string
    if (!out.shortName && typeof m.short_name === 'string') out.shortName = m.short_name as string
    if (!out.version && typeof m.version === 'string') out.version = m.version as string
    if (!out.description && typeof m.description === 'string') out.description = m.description as string
    out.installType = 'development'
    if (!Array.isArray(out.hostPermissions) || (out.hostPermissions as string[]).length === 0) {
      out.hostPermissions = ['<all_urls>']
    }
    if (!Array.isArray(out.permissions)) {
      out.permissions = Array.isArray(m.permissions) ? (m.permissions as string[]).slice() : []
    }
    out.enabled = true
    out.mayDisable = true
    out.type = out.type ?? 'extension'
    return out
  }
  const callRaw = (): Promise<unknown> => {
    if (!rawGetSelf) return Promise.resolve(undefined)
    try {
      // Try Promise-style first (Electron 41 / library returns Promise).
      const maybe = rawGetSelf()
      if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
        return maybe as Promise<unknown>
      }
      // Callback-style: re-invoke with a callback wrapped as a Promise.
      return new Promise((resolve) => {
        try {
          rawGetSelf((info: unknown) => resolve(info))
        } catch (err) {
          console.error('[newbro-ext-shim] management.getSelf callback-style raw threw:', err)
          resolve(undefined)
        }
      })
    } catch (err) {
      console.error('[newbro-ext-shim] management.getSelf promise-style raw threw:', err)
      return Promise.resolve(undefined)
    }
  }
  management.getSelf = (callback?: (info: unknown) => void) => {
    const promise = callRaw().then(decorate, (err) => {
      console.error('[newbro-ext-shim] management.getSelf raw rejected:', err)
      return decorate({})
    })
    if (typeof callback === 'function') promise.then((info) => {
      try { callback(info) }
      catch (err) { console.error('[newbro-ext-shim] management.getSelf user-cb threw:', err) }
    })
    return promise
  }

  // chrome.storage.onChanged bridge to the SW. In Electron 41,
  // chrome.storage.onChanged events fire in the writing context (this
  // popup) but DON'T propagate cross-context to the chrome-extension
  // service worker. Browsec's popup writes to chrome.storage.local
  // (e.g. country picker → mode=proxy, country=hr) and its in-popup
  // storageListener fires correctly, but the SW's identical listener
  // never fires, so the SW never re-runs setActualPac and the proxy
  // stays on the previous country / smart-only state. User-visible:
  // clicking a country / OFF in the popup looks like it took, but
  // the actual IP doesn't change.
  //
  // Timing trap: when our preload runs at document_start, the
  // electron-chrome-extensions library hasn't installed
  // chrome.storage yet (we observed hasStorage:false / hasLocal:false
  // / hasOnChangedAddListener:false at install attempt). The lib's
  // own preload writes chrome.storage onto an in-place chrome object
  // — no full reassignment — so our setter-on-chrome trap doesn't
  // fire either. Solution: poll for chrome.storage.onChanged
  // .addListener and install when it appears. Cheap (~200ms total),
  // bounded, idempotent.
  installStorageBridge(chrome)
  mapStorageSyncToLocal(chrome)
}

// chrome.storage.sync → local, for chrome-extension:// FRAME contexts
// (popups, options, and extension iframes injected into pages — e.g.
// Vimium's HUD at pages/hud.html). Electron has no storage.sync, and
// the library's sync→local aliasing doesn't take because native
// chrome.storage is non-configurable, so accessing chrome.storage.sync
// throws "sync is not available". Unlike content scripts, native
// chrome.storage.local DOES work in these frames, so we just alias sync
// (and managed) to it — poll briefly because the library may install
// chrome.storage a tick after we run.
function mapStorageSyncToLocal(chrome: Record<string, unknown>): void {
  let tries = 0
  const tick = (): void => {
    tries++
    let done = false
    try {
      const storage = chrome.storage as
        | { local?: unknown; sync?: unknown; managed?: unknown }
        | undefined
      if (storage && storage.local) {
        // Is sync already usable (not the throwing native getter)?
        let syncOk = false
        try { syncOk = !!storage.sync && storage.sync !== undefined } catch { syncOk = false }
        if (!syncOk) {
          try {
            Object.defineProperty(storage, 'sync', { value: storage.local, configurable: true, writable: true, enumerable: true })
          } catch (err) {
            try { (storage as Record<string, unknown>).sync = storage.local } catch { /* non-writable */ }
          }
        }
        try {
          const m = storage as Record<string, unknown>
          let managedOk = false
          try { managedOk = !!m.managed } catch { managedOk = false }
          if (!managedOk) {
            try { Object.defineProperty(storage, 'managed', { value: storage.local, configurable: true, writable: true, enumerable: true }) }
            catch { try { m.managed = storage.local } catch { /* ignore */ } }
          }
        } catch { /* ignore managed */ }
        done = true
      }
    } catch (err) {
      try { console.error('[newbro-ext-shim] mapStorageSyncToLocal probe threw:', err) } catch { /* console gone */ }
    }
    if (!done && tries < 60) setTimeout(tick, 50)
  }
  tick()
}

interface StorageBridgeGuard {
  __newbroStorageBridgeInstalled?: boolean
  __newbroStorageBridgePolling?: boolean
}

function installStorageBridge(chrome: Record<string, unknown>): void {
  const guard = chrome as unknown as StorageBridgeGuard
  if (guard.__newbroStorageBridgeInstalled) return
  if (guard.__newbroStorageBridgePolling) return
  guard.__newbroStorageBridgePolling = true

  let attempt = 0
  const maxAttempts = 60 // ~3s at 50ms intervals — plenty for the lib to land

  const tryInstall = (): void => {
    attempt++
    let onChanged: { addListener?: (cb: (changes: unknown, areaName: string) => void) => void } | undefined
    let hasStorage = false
    let hasLocal = false
    try {
      const cs = chrome.storage as
        | { local?: unknown; onChanged?: { addListener?: (cb: (changes: unknown, areaName: string) => void) => void } }
        | undefined
      hasStorage = !!cs
      hasLocal = !!cs?.local
      onChanged = cs?.onChanged
    } catch (err) {
      try { console.error('[newbro-ext-shim] storage-bridge probe threw:', err) }
      catch { /* console torn down */ }
    }
    const hasOnChangedAddListener = typeof onChanged?.addListener === 'function'

    if (hasOnChangedAddListener && onChanged) {
      guard.__newbroStorageBridgeInstalled = true
      guard.__newbroStorageBridgePolling = false
      try {
        ipcRenderer.send('newbro-ext-shim-trace', {
          kind: 'storage-bridge-install',
          href: typeof location !== 'undefined' ? location?.href : null,
          hasStorage,
          hasLocal,
          hasOnChangedAddListener,
          attempt,
        })
      } catch { /* ipc not ready */ }
      onChanged.addListener!((changes: unknown, areaName: string) => {
        try {
          const runtime = chrome.runtime as { id?: string } | undefined
          const extId = runtime?.id ?? ''
          const keys =
            changes && typeof changes === 'object'
              ? Object.keys(changes as Record<string, unknown>)
              : []
          try {
            ipcRenderer.send('newbro-ext-shim-trace', {
              kind: 'storage-bridge-fire',
              href: typeof location !== 'undefined' ? location?.href : null,
              extId,
              areaName,
              keys,
            })
          } catch { /* ipc gone */ }
          if (!extId || keys.length === 0) return
          // Frame contexts reach the global ipcMain directly — no need
          // for the sentinel-host fetch the SW realm historically used.
          try {
            ipcRenderer.send('newbro-ext-frame', {
              kind: 'storage-bridge',
              extId,
              areaName,
              changes,
            })
          } catch (err) {
            try { console.error('[newbro-ext-shim] storage-bridge ipc.send failed:', err) }
            catch { /* console torn down */ }
          }
        } catch (err) {
          try { console.error('[newbro-ext-shim] storage-bridge dispatch threw:', err) }
          catch { /* console torn down */ }
        }
      })
      return
    }

    if (attempt >= maxAttempts) {
      guard.__newbroStorageBridgePolling = false
      try {
        ipcRenderer.send('newbro-ext-shim-trace', {
          kind: 'storage-bridge-install-gaveup',
          href: typeof location !== 'undefined' ? location?.href : null,
          hasStorage,
          hasLocal,
          hasOnChangedAddListener,
          attempt,
        })
      } catch { /* ipc gone */ }
      return
    }

    setTimeout(tryInstall, 50)
  }

  // First attempt synchronous so we don't miss the case where storage
  // IS already available when applyPatches runs (e.g. on cached
  // popup re-show paths). Subsequent attempts back off to 50ms.
  tryInstall()
}
