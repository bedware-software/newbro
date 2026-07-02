// Branding MUST run before any electron-store instance is constructed
// (which happens transitively when './ipc' is imported below). The
// side-effect import below calls app.setName so userData / appData /
// cache directories pick up the dev-vs-stable split — otherwise every
// store grabs the default name during the import cascade and we never
// get a separate dev folder. Keep this as the FIRST internal import.
import { APP_NAME } from './branding'
// Patches `node_modules/electron-chrome-extensions/dist/cjs/index.js` BEFORE
// the lib is imported anywhere. ES module imports are statically hoisted, so
// the side-effect of this module runs prior to any `require('electron-
// chrome-extensions')` further down. Putting the patch in app.whenReady
// missed by one process-life: the lib was already in Node's require cache
// by the time the ready handler fired.
import './extensions/patch-lib-deps'
import { app, BrowserWindow, session, Menu, nativeImage, screen, protocol, systemPreferences } from 'electron'
import { dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerIpcHandlers, registerDetachedPopup } from './ipc'
import { setupAutoUpdater } from './updater'
import { initCloudSync, flushPushSync } from './cloud-sync'
import { handleServerAuth, registerHttpAuthIpc } from './http-auth'
import {
  loadState,
  loadOpenWindows,
  saveOpenWindows,
  loadWorkspaceBounds,
  saveWorkspaceBounds,
  saveLastUsedWorkspace,
  type OpenWindowEntry,
} from './store'
import { loadSettings, DEFAULT_KEYBINDINGS, type ProxySettings, type Settings } from './settings-store'
import { attachDownloadHandler } from './downloads'
import { log } from './log'
import {
  registerWorkspaceWindowForTabs,
  installTabPreloadListeners,
  closeExtensionPopup,
  getActiveTabInfoForWindow,
  createTabForExtension,
  getRecordByWebContents,
  selectTabByWebContents,
  destroyTabByWebContents,
  getWebContentsByChromeTabId,
  findTabByWebContents,
  getWindowForTabWebContents,
} from './tab-views'
import { getGrant, setGrant, type PermissionKind } from './permissions-store'
import {
  getOrCreateExtensions,
  isLibrarySelectTabSuppressed,
  subscribeBrowserActionUpdates,
  getBrowserActionStateForSession,
  type BrowserActionState,
} from './chrome-extensions-bridge'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { loadEnabledExtensionsInto, readBgSourceWindow, rehydrateExtensionsOnStartup, getExtensionEntry } from './extensions/manager'
import { startSwCdpInspector, setSwCdpAuthHandler, type SwCdpAuthResponse } from './extensions/sw-cdp-inspector'
import { startSwRpcServer, getSwRpcServerInfo } from './extensions/sw-rpc-server'
import {
  registerUserScripts,
  unregisterUserScripts,
  type RegisteredUserScript,
} from './extensions/userscripts'

// ── Single-instance lock ──
// Required for the OS-level "default browser" handoff to work end-to-end.
// On Windows and Linux, clicking an http(s) link launches `newbro <url>` —
// without the lock, every click spawns a brand-new Newbro process whose
// own window opens with no awareness of the URL we were asked to handle.
// With the lock, only the first instance survives; later launches deliver
// their argv to it via the `second-instance` event below, and we route the
// URL into an existing workspace as a new tab.
//
// macOS routes URLs via `app.on('open-url')` instead of argv, but acquiring
// the lock there is harmless and keeps the codepath uniform.
if (!app.requestSingleInstanceLock()) {
  // Second instance — original is already running and was notified via the
  // lock mechanism. Bail out immediately so no window / no background work
  // spins up; `app.quit()` is async, `process.exit` is what actually halts
  // before the rest of the module runs.
  app.quit()
  process.exit(0)
}

// ── Chromium flags ──

// Register newbro-ipc:// as a privileged scheme so the SW shim we
// inject into MV3 background scripts can do `fetch('newbro-ipc://...')`
// to query main and get a JSON response back. Without privileged +
// supportFetchAPI, fetch() of a custom scheme from a service worker
// just errors. MUST run before app.ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'newbro-ipc',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true },
  },
])

// Disable Chromium's User-Agent Client Hints so we don't send sec-ch-ua/
// sec-ch-ua-mobile/sec-ch-ua-platform headers or expose navigator.userAgentData.
// Google's sign-in rejection ("Couldn't sign you in — This browser or app may
// not be secure") is triggered by sec-ch-ua containing only "Chromium" without
// a recognized product brand like "Google Chrome". With the feature disabled,
// Google falls back to the User-Agent string alone — which is a clean Chrome UA
// after the stripping below — and sign-in goes through.
app.commandLine.appendSwitch(
  'disable-features',
  'UserAgentClientHint,UserAgentClientHintFullVersionList,GreaseUACH,CriticalClientHint'
)

// Always-on Chromium remote debugging. This lets the developer attach
// DevTools to extension service workers (and any other Chromium target)
// from a separate Chrome via chrome://inspect/#devices → Configure →
// localhost:9229. SW Network tab is the only place that reveals the
// actual `net::ERR_*` behind a fetch's generic "Failed to fetch".
//
// Port choice: 9229 is the Node.js inspector default — Electron isn't
// using Node inspector here so the port is free, and the number is
// memorable. Bound to localhost so external machines can't connect.
//
// Connect from Chrome:
//   chrome://inspect/#devices → "Configure" → add localhost:9229 →
//   SWs and pages show up under "Remote Target".
app.commandLine.appendSwitch('remote-debugging-port', '9229')
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')

// ── Integrated Windows Authentication (SSO) ──
// For hosts on this allowlist, Chromium answers NTLM/Negotiate challenges
// automatically with the logged-in Windows user's credentials — no prompt (the
// corp intranet / OWA "just works" like Edge in the Local Intranet zone).
// NOTE: this uses the *ambient* PC account. When that account isn't the corp
// identity the server expects, use the saved-credential path instead (a
// credential entered in the sign-in dialog with "remember" ticked) — those
// answer app.on('login') with explicit corp credentials. Everything not on this
// list falls back to the credentials dialog. The switch is consumed before the
// network service starts, so this must run before app-ready and a change
// requires a restart. Empty = SSO off. Read defensively — a settings read
// failure must never block startup.
try {
  const raw = loadSettings().authServerAllowlist
  const allowlist = typeof raw === 'string'
    ? raw.split(/[\s,]+/).filter(Boolean).join(',')
    : ''
  if (allowlist) {
    app.commandLine.appendSwitch('auth-server-allowlist', allowlist)
    log.info('auth: integrated SSO allowlist enabled', { allowlist })
  }
} catch (err) {
  log.warn('auth: failed to apply auth-server-allowlist', String(err))
}

// ── Certificate error bypass ──
// Origins the user has explicitly chosen to bypass for this session.
// Cleared when the app quits — not persisted.
const bypassedCertOrigins = new Set<string>()

export function addBypassedCertOrigin(url: string): void {
  try {
    bypassedCertOrigins.add(new URL(url).origin)
  } catch {
    /* ignore invalid URLs */
  }
}

// Diagnostic: log any child-process crash. Each tab is its own renderer,
// each profile has a session-process, GPU + utility helpers run separately.
// When a heavy site (Figma is the reported case) takes one of these down,
// the symptom is a workspace window that disappears with no error in the
// console — these listeners give us at least the reason code to triage on.
app.on('child-process-gone', (_e, details) => {
  log.error('child-process-gone', {
    type: details.type,
    name: (details as { name?: string }).name ?? null,
    serviceName: (details as { serviceName?: string }).serviceName ?? null,
    reason: details.reason,
    exitCode: details.exitCode,
  })
})
app.on('render-process-gone', (_e, wc, details) => {
  let url = ''
  try { url = wc.getURL() } catch (e) { log.warn('render-process-gone/getURL', String(e)) }
  log.error('app-level render-process-gone', {
    wcId: wc.id,
    type: wc.getType(),
    url,
    reason: details.reason,
    exitCode: details.exitCode,
  })
})

app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  try {
    if (bypassedCertOrigins.has(new URL(url).origin)) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    /* fall through */
  }
  callback(false)
})

// ── Branding ──
// `app.setName` runs in `./branding`, which is imported above before any
// electron-store gets constructed. The APP_NAME constant comes from there
// so visible-branding sites in this file (window titles, menus, About)
// stay in sync with the chosen userData directory.

// Remove "Electron/x.y.z" from the default user agent string. The "Newbro"
// regex stays as-is — even in dev mode the UA token (when present) uses
// the production product name; the dev suffix is purely for branding /
// directory isolation.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/[\w.]+/, '')
  .replace(/\s*newbro-browser\/[\w.]+/, '')
  .replace(/\s*Newbro\/[\w.]+/, '')

// In dev mode, patch the Electron binary's Info.plist so macOS menu bar
// shows the dev name instead of "Electron".
if (is.dev && process.platform === 'darwin') {
  try {
    const plistPath = join(
      process.execPath, '..', '..', 'Info.plist'
    )
    const plist = readFileSync(plistPath, 'utf8')
    if (plist.includes('<string>Electron</string>')) {
      const patched = plist.replace(/<string>Electron<\/string>/g, `<string>${APP_NAME}</string>`)
      writeFileSync(plistPath, patched, 'utf8')
      log.info(`patched Info.plist: Electron → ${APP_NAME} (restart to take full effect)`)
    }
  } catch (err) {
    log.warn('could not patch Info.plist for branding', err)
  }
}

// Suppress harmless Electron GUEST_VIEW_MANAGER_CALL errors caused by webview redirects
const _origConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    args[0].includes('GUEST_VIEW_MANAGER_CALL')
  ) return
  _origConsoleError(...args)
}

const configuredPartitions = new Set<string>()
const workspaceWindows = new Map<string, BrowserWindow>()
const workspaceProfiles = new Map<string, string>() // workspaceId → profileId
let lastKnownOpenWindows: OpenWindowEntry[] = []

// URLs handed to us by the OS (default-browser handoff) before any workspace
// window exists yet — typically when Newbro itself was launched by the click.
// Flushed by `flushPendingUrlsTo` once a window finishes loading.
const pendingExternalUrls: string[] = []

/** Snapshot of the most recent browser-action state we pushed for each
 *  partition. The toolbar can ask main for "what was the last state?" on
 *  mount so it doesn't have to wait for the next mutation, and the
 *  IPC handler below reads from here without re-walking the library. */
const lastBrowserActionStateByPartition = new Map<string, BrowserActionState>()

/** Per-extension flag tracking whether the SW shim has been told
 *  "this is cold start" yet for this main-process lifetime. Backs
 *  chrome.runtime.onStartup in the SW shim — see coldStartCheck
 *  in the startSwRpcServer call below for the semantic. Cleared
 *  implicitly when the main process exits (Set is in-memory). */
const coldStartFiredFor = new Set<string>()

/** Per-extension queue of pending chrome.storage.onChanged events that
 *  arrived from non-SW contexts (popup posts via 'storage-bridge')
 *  and haven't yet been picked up by the SW shim's /storage-poll
 *  long-poll. See SwRpcRoutes.storagePoll for why this bridge is
 *  necessary in Electron 41. */
type StorageChangePayload = {
  areaName: string
  changes: Record<string, unknown>
}
const queuedStorageChanges = new Map<string, StorageChangePayload[]>()
const waitingStoragePolls = new Map<string, Array<(payload: unknown) => void>>()

function deliverStorageChangeToWaiter(extId: string): void {
  const queue = queuedStorageChanges.get(extId)
  const waiters = waitingStoragePolls.get(extId)
  if (!queue || queue.length === 0) return
  if (!waiters || waiters.length === 0) return
  const change = queue.shift()!
  const wake = waiters.shift()!
  if (queue.length === 0) queuedStorageChanges.delete(extId)
  if (waiters.length === 0) waitingStoragePolls.delete(extId)
  wake({ change })
}

function waitForStorageChange(extId: string, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    let settled = false
    const wake = (payload: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const arr = waitingStoragePolls.get(extId)
      if (arr) {
        const idx = arr.indexOf(wake)
        if (idx !== -1) arr.splice(idx, 1)
        if (arr.length === 0) waitingStoragePolls.delete(extId)
      }
      resolve(payload)
    }
    const timer = setTimeout(() => wake({}), timeoutMs)
    const arr = waitingStoragePolls.get(extId) ?? []
    arr.push(wake)
    waitingStoragePolls.set(extId, arr)
    deliverStorageChangeToWaiter(extId)
  })
}

function enqueueStorageChange(
  extId: string,
  areaName: string,
  changes: Record<string, unknown>,
): void {
  const arr = queuedStorageChanges.get(extId) ?? []
  arr.push({ areaName, changes })
  queuedStorageChanges.set(extId, arr)
  deliverStorageChangeToWaiter(extId)
}

/** chrome.runtime.sendMessage bridge state.
 *
 *  Why this exists: user scripts injected via chrome.userScripts.register
 *  run in a fresh isolated world. Chromium's chrome.* binding only
 *  attaches to declared extension contexts (popup, options, content
 *  scripts declared in manifest, the SW itself). Our dynamically-injected
 *  userscript world gets none of it, so chrome.runtime.sendMessage from
 *  the user script (or Tampermonkey's content.js bootstrap) reaches a
 *  setup-stub no-op and never makes it to the SW.
 *
 *  Bridge flow:
 *    1. Userscript-world stub POSTs message → main via
 *       loopback /runtime-msg-send.
 *    2. Main parks the request, queues the message per extId.
 *    3. SW long-polls /runtime-msg-poll, drains queue, dispatches
 *       to its chrome.runtime.onMessage listeners.
 *    4. SW POSTs the listener's response (or {} if none responded) to
 *       /runtime-msg-respond keyed by msgId.
 *    5. Main correlates msgId to the parked request and resolves with
 *       the response body. The userscript fetch resolves with the
 *       SW's response. */
interface PendingRuntimeMessage {
  msgId: string
  extId: string
  payload: unknown
}
const pendingRuntimeMsgRequests = new Map<string, (response: unknown) => void>()
const queuedRuntimeMessages = new Map<string, PendingRuntimeMessage[]>()
const waitingRuntimeMsgPolls = new Map<string, Array<(payload: unknown) => void>>()

function enqueueRuntimeMessage(extId: string, payload: unknown): string {
  const msgId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const arr = queuedRuntimeMessages.get(extId) ?? []
  arr.push({ msgId, extId, payload })
  queuedRuntimeMessages.set(extId, arr)
  // Wake the first waiting poll for this extId.
  const wakes = waitingRuntimeMsgPolls.get(extId)
  if (wakes && wakes.length > 0) {
    const wake = wakes.shift()!
    if (wakes.length === 0) waitingRuntimeMsgPolls.delete(extId)
    drainRuntimeMessagesTo(extId, wake)
  }
  return msgId
}

function drainRuntimeMessagesTo(extId: string, wake: (payload: unknown) => void): void {
  const arr = queuedRuntimeMessages.get(extId) ?? []
  if (arr.length === 0) { wake({}); return }
  const next = arr.shift()!
  if (arr.length === 0) queuedRuntimeMessages.delete(extId)
  else queuedRuntimeMessages.set(extId, arr)
  wake({ message: next })
}

function waitForRuntimeMessage(extId: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false
    const wake = (payload: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const arr = waitingRuntimeMsgPolls.get(extId)
      if (arr) {
        const idx = arr.indexOf(wake)
        if (idx !== -1) arr.splice(idx, 1)
        if (arr.length === 0) waitingRuntimeMsgPolls.delete(extId)
      }
      resolve(payload)
    }
    const timer = setTimeout(() => wake({}), timeoutMs)
    if ((queuedRuntimeMessages.get(extId) ?? []).length > 0) {
      drainRuntimeMessagesTo(extId, wake)
      return
    }
    const list = waitingRuntimeMsgPolls.get(extId) ?? []
    list.push(wake)
    waitingRuntimeMsgPolls.set(extId, list)
  })
}

/** Tiny string hash for world-id derivation. Same shape as the one in
 *  src/main/extensions/userscripts.ts (worldIdForExtension); duplicated
 *  here so we can pick a per-extension isolated world for the
 *  chrome.userScripts.execute backend without exporting it. */
function hashStringForWorld(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h
}

/** chrome.runtime.connect port bridge state.
 *
 *  Same motivation as the sendMessage bridge: user scripts injected
 *  via chrome.userScripts.register land in a fresh isolated world with
 *  no chrome.* binding, so chrome.runtime.connect from the userscript
 *  (or Tampermonkey's content.js bootstrap) has nothing to talk to.
 *  We model each port as a pair of queues + waiter arrays — one
 *  direction for content→SW, the other for SW→content. Disconnects
 *  from either side notify the other.
 *
 *  Port event payloads (what the SW poll returns):
 *    { type: 'connect', portId, name }     — new port opened by content
 *    { type: 'msg',     portId, message }  — content sent a message
 *    { type: 'disconnect', portId }        — content closed the port
 *
 *  Content poll returns:
 *    { type: 'msg', message }    — SW posted to this port
 *    { type: 'disconnect' }      — SW closed the port */
interface PortBridgeState {
  extId: string
  portId: string
  name: string
  toSw: Array<{ type: 'connect' | 'msg' | 'disconnect'; portId: string; name?: string; message?: unknown }>
  toContent: Array<{ type: 'msg' | 'disconnect'; message?: unknown }>
  contentWaiters: Array<(payload: unknown) => void>
}
const portsByPortId = new Map<string, PortBridgeState>()
const portSwWaiters = new Map<string, Array<(payload: unknown) => void>>()
// Pending SW events that arrived before the SW started polling. Drained
// when /runtime-port-sw-poll wakes up.
const pendingSwPortEvents = new Map<string, PortBridgeState['toSw']>()

function pushSwEvent(extId: string, event: PortBridgeState['toSw'][number]): void {
  const wakes = portSwWaiters.get(extId)
  if (wakes && wakes.length > 0) {
    const wake = wakes.shift()!
    if (wakes.length === 0) portSwWaiters.delete(extId)
    wake({ event })
    return
  }
  const queue = pendingSwPortEvents.get(extId) ?? []
  queue.push(event)
  pendingSwPortEvents.set(extId, queue)
}

function pushContentEvent(port: PortBridgeState, event: PortBridgeState['toContent'][number]): void {
  if (port.contentWaiters.length > 0) {
    const wake = port.contentWaiters.shift()!
    wake({ event })
    return
  }
  port.toContent.push(event)
}

function openPort(extId: string, name: string): string {
  const portId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const port: PortBridgeState = {
    extId,
    portId,
    name,
    toSw: [],
    toContent: [],
    contentWaiters: [],
  }
  portsByPortId.set(portId, port)
  pushSwEvent(extId, { type: 'connect', portId, name })
  log.info('rpc/port-open', { extId, portId, name })
  return portId
}

function portContentSend(portId: string, message: unknown): void {
  const port = portsByPortId.get(portId)
  if (!port) return
  pushSwEvent(port.extId, { type: 'msg', portId, message })
}

function portSwSend(portId: string, message: unknown): void {
  const port = portsByPortId.get(portId)
  if (!port) return
  pushContentEvent(port, { type: 'msg', message })
}

function portContentPoll(portId: string, timeoutMs: number): Promise<unknown> {
  const port = portsByPortId.get(portId)
  if (!port) return Promise.resolve({ event: { type: 'disconnect' } })
  if (port.toContent.length > 0) {
    return Promise.resolve({ event: port.toContent.shift()! })
  }
  return new Promise((resolve) => {
    let settled = false
    const wake = (payload: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const idx = port.contentWaiters.indexOf(wake)
      if (idx !== -1) port.contentWaiters.splice(idx, 1)
      resolve(payload)
    }
    const timer = setTimeout(() => wake({}), timeoutMs)
    port.contentWaiters.push(wake)
  })
}

function portSwPoll(extId: string, timeoutMs: number): Promise<unknown> {
  const pending = pendingSwPortEvents.get(extId)
  if (pending && pending.length > 0) {
    const event = pending.shift()!
    if (pending.length === 0) pendingSwPortEvents.delete(extId)
    return Promise.resolve({ event })
  }
  return new Promise((resolve) => {
    let settled = false
    const wake = (payload: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const arr = portSwWaiters.get(extId)
      if (arr) {
        const idx = arr.indexOf(wake)
        if (idx !== -1) arr.splice(idx, 1)
        if (arr.length === 0) portSwWaiters.delete(extId)
      }
      resolve(payload)
    }
    const timer = setTimeout(() => wake({}), timeoutMs)
    const arr = portSwWaiters.get(extId) ?? []
    arr.push(wake)
    portSwWaiters.set(extId, arr)
  })
}

function portDisconnect(portId: string, side: 'content' | 'sw'): void {
  const port = portsByPortId.get(portId)
  if (!port) return
  portsByPortId.delete(portId)
  if (side === 'content') {
    // Content disconnected → notify SW.
    pushSwEvent(port.extId, { type: 'disconnect', portId })
  } else {
    // SW disconnected → notify content.
    pushContentEvent(port, { type: 'disconnect' })
  }
}

/** Pending HTTP auth challenges from ses.webRequest.onAuthRequired,
 *  keyed by a synthetic challenge id. Resolved when the extension's
 *  SW POSTs back via newbro-ipc/auth-respond. */
type PendingAuthChallenge = {
  partition: string
  details: Record<string, unknown>
  callback: (response: { username?: string; password?: string; cancel?: boolean } | Record<string, never>) => void
  timer: NodeJS.Timeout
}
const pendingAuthChallenges = new Map<string, PendingAuthChallenge>()
/** Auth challenges waiting to be picked up by an SW's webRequest.onAuthRequired
 *  listener, keyed by challengeId. We track which extension SWs have already
 *  received each challenge so a fan-out delivery model works: every extension
 *  whose SW is currently long-polling /auth-poll gets a copy, and the FIRST
 *  one to respond resolves the challenge (subsequent responses no-op via
 *  pendingAuthChallenges.delete()). Was a global FIFO queue before — that
 *  worked when only one extension (Browsec) handled proxy auth, but missed
 *  delivery in 2+ VPN scenarios because each shift() handed the challenge
 *  to whichever SW polled first, leaving the others blind. */
interface QueuedChallenge {
  id: string
  partition: string
  details: Record<string, unknown>
  deliveredTo: Set<string>
}
const queuedChallenges = new Map<string, QueuedChallenge>()
/** Polls currently waiting for a challenge, keyed by extension id. One
 *  extension's SW maintains a single in-flight long-poll at a time, but
 *  in transient states (response just sent, new poll about to land) we
 *  may have brief overlap, so each extId tracks an array of wake'rs. */
const waitingAuthPolls = new Map<string, Array<(payload: unknown) => void>>()

/** Push a new challenge into the queue and fan it out to every extension
 *  currently long-polling /auth-poll for this partition. Each waiter
 *  receives a copy; first responder wins. */
function enqueueAuthChallenge(challenge: QueuedChallenge): void {
  queuedChallenges.set(challenge.id, challenge)
  fanOutChallenge(challenge)
}

function fanOutChallenge(challenge: QueuedChallenge): void {
  for (const [extId, wakes] of waitingAuthPolls) {
    if (challenge.deliveredTo.has(extId)) continue
    const wake = wakes.shift()
    if (!wake) continue
    if (wakes.length === 0) waitingAuthPolls.delete(extId)
    challenge.deliveredTo.add(extId)
    wake({ challenge: { id: challenge.id, details: challenge.details } })
  }
}

/** When a fresh poll arrives, hand it the oldest challenge that hasn't
 *  yet been delivered to this extId. */
function maybeDeliverPending(extId: string, wake: (payload: unknown) => void): boolean {
  for (const challenge of queuedChallenges.values()) {
    if (challenge.deliveredTo.has(extId)) continue
    challenge.deliveredTo.add(extId)
    wake({ challenge: { id: challenge.id, details: challenge.details } })
    return true
  }
  return false
}

function waitForAuthChallenge(extId: string, timeoutMs: number): Promise<Response> {
  return new Promise<Response>((resolve) => {
    let settled = false
    const wake = (payload: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Detach from the waiters list — only if we're still there. If
      // fanOutChallenge already plucked us, the splice is a no-op.
      const arr = waitingAuthPolls.get(extId)
      if (arr) {
        const idx = arr.indexOf(wake)
        if (idx !== -1) arr.splice(idx, 1)
        if (arr.length === 0) waitingAuthPolls.delete(extId)
      }
      resolve(new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      }))
    }
    const timer = setTimeout(() => wake({}), timeoutMs)
    // Deliver an already-queued challenge first if any.
    if (maybeDeliverPending(extId, wake)) return
    // Otherwise park the wake'r in the per-extension list.
    const list = waitingAuthPolls.get(extId) ?? []
    list.push(wake)
    waitingAuthPolls.set(extId, list)
  })
}

function resolveAuthChallenge(
  challengeId: string,
  response: { authCredentials?: { username?: string; password?: string }; cancel?: boolean },
): void {
  const entry = pendingAuthChallenges.get(challengeId)
  if (!entry) return
  pendingAuthChallenges.delete(challengeId)
  queuedChallenges.delete(challengeId)
  clearTimeout(entry.timer)
  if (response.cancel) {
    entry.callback({ cancel: true })
  } else if (response.authCredentials && typeof response.authCredentials.username === 'string') {
    entry.callback({
      username: response.authCredentials.username,
      password: response.authCredentials.password ?? '',
    })
  } else {
    entry.callback({})
  }
}

/** Register the global app.on('login') handler exactly once. Lifecycle:
 *  1. app 'login' fires with the auth challenge,
 *  2. We map webContents.session → partition; bail if no match,
 *  3. Park the chromium-side callback in pendingAuthChallenges,
 *  4. Hand the challenge details to that partition's SW via auth-poll,
 *  5. The SW's listener replies via auth-respond,
 *  6. We invoke the parked chromium callback with credentials.
 *
 *  NEVER register this from inside per-session setup — Electron's
 *  callback is one-shot, and N listeners parking N timers all aimed
 *  at the same callback dies hard with "One-time callback was called
 *  more than once" the moment any of them resolve.
 *
 *  Note: app.on('login') primarily covers webContents-initiated
 *  requests (tab navigations and subresources). Service-worker-
 *  initiated fetches (Browsec's webstat.me SmartSettings ping,
 *  dynamic-config gist, etc.) don't reliably reach this event in
 *  Electron 41 — they're handled instead by the CDP Fetch.authRequired
 *  router wired in app.whenReady, which forwards via the same
 *  pendingAuthChallenges + queuedChallenges machinery. The SW shim's
 *  auth-poll consumes from both surfaces transparently. */
let loginHandlerInstalled = false
function installLoginHandlerOnce(): void {
  if (loginHandlerInstalled) return
  loginHandlerInstalled = true
  app.on('login', (event, webContents, requestDetails, authInfo, callback) => {
    // Trace ENTRY unconditionally — we need to know whether this fires
    // for SW-initiated fetches (Browsec's webstat.me ping et al.) and
    // what shape the args take in Electron 41. Without this trace we
    // can't tell the difference between "event didn't fire" and
    // "event fired but our handler bailed".
    log.info('extensions: app.on(login) fired', {
      url: requestDetails.url,
      isProxy: authInfo.isProxy,
      scheme: authInfo.scheme,
      hasWebContents: !!webContents,
      wcType: webContents ? (webContents as { getType?: () => string }).getType?.() : null,
      wcId: webContents ? webContents.id : null,
    })
    // Server auth (not a proxy) for a real tab → answer with a saved corp
    // credential if we have one, else prompt the user, like a normal browser
    // (Basic / Digest / NTLM / Negotiate). The extension/SW routing below is
    // only for proxy challenges (e.g. Browsec) and service-worker fetches,
    // which a corporate site's 401 is not.
    if (!authInfo.isProxy && webContents) {
      const authWin = getWindowForTabWebContents(webContents)
      if (authWin) {
        event.preventDefault()
        handleServerAuth(
          authWin,
          requestDetails.url,
          {
            isProxy: authInfo.isProxy,
            scheme: authInfo.scheme,
            host: authInfo.host,
            port: authInfo.port,
            realm: authInfo.realm,
          },
          callback,
        )
        return
      }
    }
    // Try to resolve the partition from webContents.session. If
    // webContents is missing, fall back to "the only configured
    // partition" — this is a single-profile-active heuristic that
    // covers SW-initiated fetches in Electron 41 (where the lib
    // doesn't surface a webContents for service-worker requests).
    let partition: string | null = null
    if (webContents) {
      const ses = webContents.session
      for (const p of configuredPartitions) {
        if (session.fromPartition(p) === ses) { partition = p; break }
      }
    }
    if (!partition && configuredPartitions.size === 1) {
      // Single partition active → all SW auth has to belong to it.
      // For multi-profile setups we can't disambiguate from authInfo
      // alone (proxy.host doesn't identify which extension owns it),
      // so we'd let those challenges fall through to Electron's
      // default-cancel rather than misroute them.
      partition = Array.from(configuredPartitions)[0]
    }
    if (!partition) {
      log.info('extensions: app.on(login) fired but no partition matched, leaving to default', {
        url: requestDetails.url,
        configuredPartitionCount: configuredPartitions.size,
      })
      return
    }
    event.preventDefault()
    const challengeId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const detailsLite = {
      url: requestDetails.url,
      // electron.d.ts types the login details as {url, pid} only; `method`
      // is not part of the documented shape, so read it defensively —
      // undefined just drops the field from the challenge payload.
      method: (requestDetails as Electron.AuthenticationResponseDetails & { method?: string }).method,
      isProxy: authInfo.isProxy,
      scheme: authInfo.scheme,
      realm: authInfo.realm,
      challenger: { host: authInfo.host, port: authInfo.port },
    }
    pendingAuthChallenges.set(challengeId, {
      partition,
      details: detailsLite,
      callback: (resp) => {
        if (resp && typeof resp.username === 'string') callback(resp.username, resp.password ?? '')
        else callback()
      },
      timer: setTimeout(() => {
        if (pendingAuthChallenges.delete(challengeId)) {
          log.warn('extensions: auth challenge timed out — no listener responded', { partition, url: requestDetails.url })
          callback()
        }
      }, 15000),
    })
    enqueueAuthChallenge({ id: challengeId, partition, details: detailsLite, deliveredTo: new Set() })
    log.info('extensions: auth challenge queued', { partition, challengeId, url: requestDetails.url, isProxy: authInfo.isProxy, source: 'app.on(login)' })
  })
}


function partitionForWorkspace(workspaceId: string): string | null {
  const profileId = workspaceProfiles.get(workspaceId)
  return profileId ? `persist:profile-${profileId}` : null
}

function partitionForBrowserWindow(win: BrowserWindow): string | null {
  for (const [wsId, w] of workspaceWindows) {
    if (w === win) return partitionForWorkspace(wsId)
  }
  return null
}

/** Late-register the partition (profileId) for the workspace window that
 *  hosts the given webContents. The window is opened early via
 *  createWorkspaceWindow — at that point the saved state may carry an empty
 *  profileId (first launch, or stale `lastKnownOpenWindows` entries from
 *  before the workspace state was hydrated). The renderer fires
 *  `session:setup` once it knows the active profile, and we use that hook
 *  to backfill the workspaceProfiles map. Without this, the partition
 *  match in broadcastBrowserActionState never lands and the toolbar icon
 *  never sees chrome.action.setIcon / setBadgeText updates — the icon
 *  appears stuck on the manifest default even though main is happily
 *  receiving every actionMap mutation. */
export function bindWebContentsToPartition(wc: Electron.WebContents, partition: string): void {
  const m = partition.match(/^persist:profile-(.+)$/)
  if (!m) return
  const profileId = m[1]
  for (const [wsId, win] of workspaceWindows) {
    if (win.isDestroyed()) continue
    if (win.webContents !== wc) continue
    const prior = workspaceProfiles.get(wsId)
    if (prior === profileId) return
    workspaceProfiles.set(wsId, profileId)
    log.info('workspace-profile rebind', { workspaceId: wsId, profileId, prior: prior ?? null })
    // Re-broadcast the last-known state for this partition so the window
    // catches up immediately — the prior broadcast happened before the
    // mapping existed, so its sentTo was 0 and the renderer is still
    // looking at the manifest default.
    const cached = lastBrowserActionStateByPartition.get(partition)
    if (cached) broadcastBrowserActionState(partition, cached)
    return
  }
}

function broadcastBrowserActionState(partition: string, state: BrowserActionState): void {
  lastBrowserActionStateByPartition.set(partition, state)
  let sentTo = 0
  for (const [wsId, win] of workspaceWindows) {
    if (win.isDestroyed()) continue
    if (partitionForWorkspace(wsId) !== partition) continue
    win.webContents.send('extensions:browser-action-state', { partition, ...state })
    sentTo++
  }
  log.info('extensions: broadcast browser-action-state', {
    partition,
    sentTo,
    totalWindows: workspaceWindows.size,
    actions: state.actions.map((a) => ({ id: a.id, text: a.text, iconMod: a.iconModified })),
  })
}

export function getBrowserActionStateForWindow(
  win: BrowserWindow,
): { partition: string | null; state: BrowserActionState } {
  const partition = partitionForBrowserWindow(win)
  if (!partition) return { partition: null, state: { actions: [] } }
  const cached = lastBrowserActionStateByPartition.get(partition)
  if (cached) return { partition, state: cached }
  // First fetch before any subscribe-triggered initial fire — read live.
  return { partition, state: getBrowserActionStateForSession(session.fromPartition(partition)) }
}

// Resolve icon paths once. On Windows use the multi-size .ico: windows with a
// native frame (DevTools, OAuth popups, any standard-frame child) render a tiny
// 16x16 title-bar icon, and a single-size 256 source makes Windows crop it (you
// see only the top of the logo) instead of downscaling. The .ico carries
// 16/24/32/48/64/128/256 so every slot gets a real sub-size. macOS/Linux keep
// the PNG (dock/icns pipeline).
const iconPng = join(__dirname, '../../resources/icon.png')
const iconIco = join(__dirname, '../../resources/icon.ico')
const windowIcon = process.platform === 'win32' ? iconIco : iconPng

/** Pull the first URL-shaped argv entry. The OS appends the URL after our
 *  binary path on Windows / Linux when handing off http(s) clicks. */
function pickUrlFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string') continue
    if (/^https?:\/\//i.test(a)) return a
  }
  return null
}

// Tracks the workspace window the user touched most recently. External URL
// handoffs from other apps land here, since at that moment Newbro itself is
// NOT focused (the OS-source app is), so `BrowserWindow.getFocusedWindow()`
// is the wrong question to ask. Updated by a `focus` listener registered
// per workspace window in `createWorkspaceWindow`, and seeded on window
// creation so it's never stale at the moment of the first OS handoff.
let lastActiveWorkspaceId: string | null = null

/** Live snapshot of currently-open workspace windows, most-recently-active
 *  first so callers that need to focus "any" window of a profile pick the
 *  one the user touched last. */
export function getOpenWorkspaceWindows(): OpenWindowEntry[] {
  const entries: OpenWindowEntry[] = []
  for (const [wsId, win] of workspaceWindows) {
    if (win.isDestroyed()) continue
    const entry = { profileId: workspaceProfiles.get(wsId) ?? '', workspaceId: wsId }
    if (wsId === lastActiveWorkspaceId) entries.unshift(entry)
    else entries.push(entry)
  }
  return entries
}

function getTargetWorkspaceWindow(): BrowserWindow | null {
  // Prefer the most-recently-active workspace — what "the current window"
  // means from the user's perspective when they click an external link.
  if (lastActiveWorkspaceId) {
    const w = workspaceWindows.get(lastActiveWorkspaceId)
    if (w && !w.isDestroyed()) return w
  }
  // Fallback: any open workspace window. Hits when the focus listener
  // hasn't fired yet (e.g. the very first window of a cold start that
  // received a URL via argv before showing).
  for (const w of workspaceWindows.values()) {
    if (!w.isDestroyed()) return w
  }
  return null
}

/** Hand a URL off to a workspace window's renderer as a new tab. The
 *  renderer subscribes to this channel in App.tsx (`onOpenUrlAsTab`) and
 *  routes the URL through addTab / addUngroupedTab on the active group or
 *  workspace. If no window is up yet (cold start by an OS link click), the
 *  URL is queued and flushed once the first window finishes loading. */
function dispatchExternalUrl(url: string): void {
  const target = getTargetWorkspaceWindow()
  if (!target) {
    pendingExternalUrls.push(url)
    log.info('dispatchExternalUrl: no window yet, queued', { url })
    return
  }
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
  // Use the dedicated 'open-external-url' channel — the renderer routes
  // this through the picker dialog so the user can choose a workspace /
  // group. The plain 'open-url-as-tab' channel is reserved for in-app
  // new-tab handoffs (Cmd+Click, target=_blank, extension chrome.tabs
  // .create, etc.) which should land directly without a prompt.
  target.webContents.send('open-external-url', url)
  log.info('dispatchExternalUrl: routed to window', { url, windowId: target.id })
}

/** Flush any URLs that arrived before a window existed. Wait for the
 *  renderer to finish loading and add a small grace period so React has
 *  attached its `onOpenUrlAsTab` listener. Re-running on later windows is
 *  safe — pendingExternalUrls is drained on first flush. */
function flushPendingUrlsTo(win: BrowserWindow): void {
  if (pendingExternalUrls.length === 0) return
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const list = pendingExternalUrls.splice(0)
      for (const url of list) dispatchExternalUrl(url)
    }, 250)
  })
}

// Second-instance: another `newbro …` invocation handed us its argv via the
// single-instance lock. Pull the URL out (if any) and route it; otherwise
// just bring an existing window forward.
app.on('second-instance', (_e, argv) => {
  const url = pickUrlFromArgv(argv)
  log.info('second-instance', { url, argv })
  if (url) {
    dispatchExternalUrl(url)
    return
  }
  const w = getTargetWorkspaceWindow()
  if (w) {
    if (w.isMinimized()) w.restore()
    w.focus()
  }
})

// macOS dispatches URL clicks via this event regardless of whether the app
// was already running. preventDefault is conventional even though Electron
// has no built-in default action.
app.on('open-url', (e, url) => {
  e.preventDefault()
  log.info('open-url', { url, isReady: app.isReady() })
  if (app.isReady()) {
    dispatchExternalUrl(url)
  } else {
    pendingExternalUrls.push(url)
  }
})

// Cold-start handoff on Windows / Linux: the OS launched us *with* the URL
// in argv. Stash it now; the first window we open will flush it.
{
  const initialUrl = pickUrlFromArgv(process.argv)
  if (initialUrl) {
    log.info('initial argv URL detected', { initialUrl })
    pendingExternalUrls.push(initialUrl)
  }
}

function normalizeShortcutKeyToken(raw: string): string {
  const key = raw.trim().toLowerCase()
  switch (key) {
    case 'return':
      return 'enter'
    case 'space':
      return ' '
    default:
      return key
  }
}

function keyTokenFromInput(input: Electron.Input): string {
  const code = (input.code || '').trim()
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5).toLowerCase()
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6).toLowerCase()
  return normalizeShortcutKeyToken(input.key || '')
}

function parseTabLeaderShortcut(binding: string | undefined): string | null {
  if (!binding) return null
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  if (parts[0].toLowerCase() !== 'tab') return null
  const key = normalizeShortcutKeyToken(parts[1])
  return key || null
}

interface ParsedAccelerator {
  key: string
  shift: boolean
  alt: boolean
  cmdOrCtrl: boolean
}

function parseAcceleratorShortcut(binding: string | undefined): ParsedAccelerator | null {
  if (!binding) return null
  const parts = binding.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null

  let shift = false
  let alt = false
  let cmdOrCtrl = false
  let key: string | null = null

  for (const rawPart of parts) {
    const part = rawPart.toLowerCase()
    if (part === 'shift') {
      shift = true
      continue
    }
    if (part === 'alt' || part === 'option') {
      alt = true
      continue
    }
    if (part === 'cmdorctrl') {
      cmdOrCtrl = true
      continue
    }
    // Tab+X chord (Tab as leader) is handled by parseTabLeaderShortcut — only
    // reject when Tab appears at the leader position (first token, no modifiers
    // seen yet). With modifiers like CmdOrCtrl+Tab, Tab is a regular key.
    if (part === 'tab' && !shift && !alt && !cmdOrCtrl && !key) return null
    if (key) return null
    key = normalizeShortcutKeyToken(rawPart)
  }

  if (!key) return null
  return { key, shift, alt, cmdOrCtrl }
}

function resolveTabCycleBindings(
  keybindings: Record<string, string[]>,
  action: 'next-tab' | 'prev-tab',
  fallback: string,
): string[] {
  const stored = keybindings[action]
  // An empty array means the user explicitly cleared all bindings; respect
  // that. Only a missing key falls back to the platform default.
  const candidates = Array.isArray(stored) ? stored : [fallback]
  const out: string[] = []
  for (const raw of candidates) {
    const trimmed = (raw || '').trim()
    if (!trimmed) continue
    if (parseTabLeaderShortcut(trimmed) || parseAcceleratorShortcut(trimmed)) {
      out.push(trimmed)
    }
  }
  return out
}

function matchesAccelerator(input: Electron.Input, shortcut: ParsedAccelerator | null): boolean {
  if (!shortcut) return false
  const key = keyTokenFromInput(input)
  if (!key || key !== shortcut.key) return false

  const hasShift = !!input.shift
  const hasAlt = !!input.alt
  const hasCmdOrCtrl = !!input.meta || !!input.control

  if (hasShift !== shortcut.shift) return false
  if (hasAlt !== shortcut.alt) return false
  if (hasCmdOrCtrl !== shortcut.cmdOrCtrl) return false
  return true
}

function installShortcutInterceptor(source: Electron.WebContents, targetWindow: BrowserWindow): void {
  let tabDown = false
  let tabResetTimer: NodeJS.Timeout | null = null

  const clearTabState = () => {
    tabDown = false
    if (tabResetTimer) {
      clearTimeout(tabResetTimer)
      tabResetTimer = null
    }
  }

  const armTabState = () => {
    tabDown = true
    if (tabResetTimer) clearTimeout(tabResetTimer)
    tabResetTimer = setTimeout(() => {
      tabDown = false
      tabResetTimer = null
    }, 900)
  }

  source.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return

    const key = keyTokenFromInput(input)
    const noOtherModifiers = !input.alt && !input.control && !input.meta && !input.shift

    const settings = loadSettings()
    const keybindings = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }

    // Tab-leader chord support (e.g. "Tab+J" for next-tab): resolved separately
    // because parseAcceleratorShortcut rejects Tab-as-leader bindings. Each
    // action may carry up to two bindings; collect every Tab-leader from
    // both slots so either fires the chord.
    const nextBindings = resolveTabCycleBindings(keybindings, 'next-tab', 'CmdOrCtrl+Tab')
    const prevBindings = resolveTabCycleBindings(keybindings, 'prev-tab', 'CmdOrCtrl+Shift+Tab')
    const nextLeaderKeys = nextBindings
      .map(parseTabLeaderShortcut)
      .filter((k): k is string => !!k)
    const prevLeaderKeys = prevBindings
      .map(parseTabLeaderShortcut)
      .filter((k): k is string => !!k)

    // Plain Tab: arm the chord if the user has a Tab-leader binding configured.
    if (key === 'tab' && noOtherModifiers) {
      if (nextLeaderKeys.length > 0 || prevLeaderKeys.length > 0) {
        armTabState()
        // Prevent native focus traversal so Tab+J/K remains reliable.
        event.preventDefault()
        log.info('tab-chord: armed', { nextLeaderKeys, prevLeaderKeys })
      }
      return
    }

    // Second key in an armed Tab-leader chord.
    if (tabDown && noOtherModifiers) {
      if (key && nextLeaderKeys.includes(key)) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'next-tab')
        clearTabState()
        return
      }
      if (key && prevLeaderKeys.includes(key)) {
        event.preventDefault()
        if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', 'prev-tab')
        clearTabState()
        return
      }
      if (key !== 'tab') {
        clearTabState()
      }
    }

    // Match against every user-defined accelerator-style keybinding. We run
    // here (before-input-event) rather than relying only on native menu
    // accelerators because menu accelerators can lose the race when a page's
    // own keydown handler calls preventDefault — e.g. Yandex Code capturing
    // Ctrl+P to jump to a matching parenthesis. Intercepting at
    // before-input-event runs BEFORE any page script sees the key, and
    // calling event.preventDefault() here cancels both the page keydown
    // AND the menu shortcut, so there's no double dispatch. Each action
    // may have up to two bindings; either should fire.
    for (const action of Object.keys(keybindings)) {
      const bindings = keybindings[action] || []
      for (const binding of bindings) {
        const parsed = parseAcceleratorShortcut(binding)
        if (!parsed) continue
        if (matchesAccelerator(input, parsed)) {
          event.preventDefault()
          if (!targetWindow.isDestroyed()) targetWindow.webContents.send('shortcut', action)
          return
        }
      }
    }
  })

  source.once('destroyed', clearTabState)
}

function sanitizeProxyRules(rules: string): string {
  return rules.replace(/\/\/[^@/]+@/g, '//***:***@')
}

function toElectronProxyConfig(proxy: ProxySettings): Electron.ProxyConfig {
  switch (proxy.mode) {
    case 'direct':
      return { mode: 'direct' }
    case 'custom': {
      const rules = (proxy.proxyRules || '').trim()
      if (!rules) return { mode: 'direct' }
      return {
        mode: 'fixed_servers',
        proxyRules: rules,
        proxyBypassRules: proxy.proxyBypassRules || '<-loopback>',
      }
    }
    case 'system':
    default:
      return { mode: 'system' }
  }
}

function applyProxyToSession(ses: Electron.Session, settings: Settings): void {
  const cfg = toElectronProxyConfig(settings.proxy)
  ses.setProxy(cfg)
    .then(async () => {
      // forceReloadProxyConfig makes NEW requests pick up the proxy.
      // We deliberately don't call closeAllConnections here — that
      // would kill any in-flight tab navigation (e.g. workspace-restore
      // tabs that started loading microseconds before this Promise
      // resolves), which surfaced as a 100%-reproducible ERR_FAILED on
      // ya.ru on app start. In-flight connections keep their original
      // proxy state, which for app boot is harmless (the connection
      // just started, no leak window). For a mid-session VPN switch,
      // in-flight requests finish through the old proxy — accept that
      // small leak in exchange for tab-load reliability.
      await ses.forceReloadProxyConfig()
      log.info('proxy applied to session', {
        mode: settings.proxy.mode,
        proxyRules: sanitizeProxyRules(settings.proxy.proxyRules || ''),
      })
    })
    .catch((err) => {
      log.error('failed to apply proxy settings', err)
    })
}

export function applyProxySettingsToAllSessions(settings: Settings): void {
  const allSessions = new Set<Electron.Session>([session.defaultSession])
  for (const partition of configuredPartitions) {
    allSessions.add(session.fromPartition(partition))
  }
  for (const ses of allSessions) {
    applyProxyToSession(ses, settings)
  }
}

/** Absolute path to the webview stealth preload, compiled by electron-vite
 *  alongside the main preload. Injected into every webview session so the
 *  navigator/chrome fingerprint overrides run before any page script. */
const WEBVIEW_STEALTH_PRELOAD = join(__dirname, '../preload/webview-stealth.js')

/** Absolute path to the extension shim — a small chrome.* polyfill (mainly
 *  chrome.tabs.create / chrome.windows.create / chrome.runtime.openOptionsPage)
 *  that fills the gaps Electron 41 leaves. Self-disables outside
 *  chrome-extension:// contexts; registered on every partition session
 *  for both frames and MV3 service workers (the latter is where
 *  Tampermonkey's Dashboard-button click handler runs). */
const EXTENSION_SHIM_PRELOAD = join(__dirname, '../preload/extension-shim.js')

// ── Site permissions ───────────────────────────────────────────────────
// The permission gate. Electron's default (and our previous behaviour) was
// to blanket-grant every permission a page asked for. We now gate the
// user-meaningful ones (mic / camera / location / notifications / clipboard /
// MIDI) behind a per-site decision: a remembered grant in permissions-store,
// else the global default in settings (`permissionDefaults`), else an in-page
// prompt routed to the owning window's renderer. Everything else Electron
// asks about (fullscreen, pointerLock, openExternal, the OAuth window.open
// flow, downloads, …) is still allowed unconditionally so nothing regresses.

interface PendingPermission {
  /** Resolve the request handler's callback with the user's decision. */
  settle: (granted: boolean) => void
  partition: string
  origin: string
  kinds: PermissionKind[]
}
const pendingPermissions = new Map<string, PendingPermission>()
let permissionReqSeq = 0

/** Loose shape covering both handlers' `details`: the request handler passes
 *  `mediaTypes` (array), the check handler passes `mediaType` (single). */
interface PermissionDetails {
  requestingUrl?: string
  mediaTypes?: string[]
  mediaType?: string
}

/** Map an Electron permission string (+details) to the managed kinds it
 *  represents. Returns [] for permissions we don't gate — the caller allows
 *  those unconditionally. */
function mapPermissionToKinds(permission: string, details?: PermissionDetails | null): PermissionKind[] {
  switch (permission) {
    case 'media': {
      const types = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : [])
      const kinds: PermissionKind[] = []
      if (types.includes('audio')) kinds.push('microphone')
      if (types.includes('video')) kinds.push('camera')
      // A media request with no specified type is treated as mic+camera so
      // we never silently allow capture we meant to gate.
      return kinds.length ? kinds : ['microphone', 'camera']
    }
    case 'audioCapture':
      return ['microphone']
    case 'videoCapture':
      return ['camera']
    case 'geolocation':
      return ['geolocation']
    case 'notifications':
      return ['notifications']
    case 'clipboard-read':
      return ['clipboard']
    case 'midi':
    case 'midiSysex':
      return ['midi']
    default:
      return []
  }
}

/** http(s) origin for the requesting page, or null for schemes we don't gate
 *  (extension pages, file://, internal). Null => allow unconditionally. */
function gatedOrigin(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

function safeGetUrl(wc: Electron.WebContents): string | undefined {
  try {
    return wc.getURL()
  } catch {
    return undefined
  }
}

type OsMediaKind = 'microphone' | 'camera'

/** macOS gates mic/camera behind a system (TCC) prompt on top of the per-site
 *  grant. Granting at the Electron level alone makes getUserMedia fail
 *  silently — this surfaces the OS prompt the first time and returns the media
 *  kinds the OS ultimately *refuses* (status denied/restricted, or a fresh
 *  prompt was declined). Empty result = all clear. No-op off macOS. */
async function ensureOsMediaAccess(kinds: PermissionKind[]): Promise<OsMediaKind[]> {
  if (process.platform !== 'darwin') return []
  const blocked: OsMediaKind[] = []
  for (const kind of kinds) {
    if (kind !== 'microphone' && kind !== 'camera') continue
    const status = systemPreferences.getMediaAccessStatus(kind)
    if (status === 'granted') continue
    if (status === 'denied' || status === 'restricted') {
      // Already denied at the OS level — macOS won't re-prompt; the user has
      // to flip it in System Settings. Surface it (see notifyOsMediaBlocked).
      log.warn('permissions: OS media access blocked — enable in System Settings', { kind, status })
      blocked.push(kind)
      continue
    }
    // 'not-determined' → surface the OS prompt.
    try {
      const ok = await systemPreferences.askForMediaAccess(kind)
      if (!ok) blocked.push(kind)
    } catch (err) {
      log.warn('permissions: askForMediaAccess threw', { kind, err: String(err) })
      blocked.push(kind)
    }
  }
  return blocked
}

/** Tell the requesting tab's window that macOS is blocking media so the
 *  renderer can show an actionable "Open System Settings" bar. */
function notifyOsMediaBlocked(wc: Electron.WebContents, kinds: OsMediaKind[]): void {
  const ctx = findTabByWebContents(wc)
  if (!ctx) return
  const win = BrowserWindow.fromId(ctx.windowId)
  if (!win || win.isDestroyed()) return
  win.webContents.send('permission:os-blocked', { tabId: ctx.tabId, kinds })
}

/** Ask the owning window's renderer to show the Allow/Block prompt and wait
 *  for the click. Resolves false if we can't surface a prompt (the requester
 *  isn't a tab, or its window/tab went away before answering). */
function promptForPermission(
  wc: Electron.WebContents,
  partition: string,
  origin: string,
  kinds: PermissionKind[],
): Promise<boolean> {
  const ctx = findTabByWebContents(wc)
  if (!ctx) {
    log.info('permissions: no tab for requester — denying ask', { origin, kinds })
    return Promise.resolve(false)
  }
  const win = BrowserWindow.fromId(ctx.windowId)
  if (!win || win.isDestroyed()) return Promise.resolve(false)
  const requestId = `perm-${++permissionReqSeq}`
  return new Promise<boolean>((resolve) => {
    const settle = (granted: boolean): void => {
      if (!pendingPermissions.has(requestId)) return
      pendingPermissions.delete(requestId)
      resolve(granted)
    }
    pendingPermissions.set(requestId, { settle, partition, origin, kinds })
    // If the requesting page goes away before the user answers, stop waiting.
    wc.once('destroyed', () => settle(false))
    win.webContents.send('permission:request', { requestId, origin, kinds, tabId: ctx.tabId })
  })
}

async function decidePermission(
  wc: Electron.WebContents,
  permission: string,
  details: PermissionDetails | null | undefined,
  partition: string,
): Promise<boolean> {
  const kinds = mapPermissionToKinds(permission, details)
  if (kinds.length === 0) return true // unmanaged → preserve allow-all

  const origin = gatedOrigin(details?.requestingUrl) ?? gatedOrigin(safeGetUrl(wc))
  if (!origin) return true // non-web origin (extension / internal) → allow

  const defaults = loadSettings().permissionDefaults
  let needPrompt = false
  let blocked = false
  for (const kind of kinds) {
    const decision = getGrant(partition, origin, kind) ?? defaults[kind] ?? 'ask'
    if (decision === 'block') blocked = true
    else if (decision === 'ask') needPrompt = true
  }
  log.info('permissions: request', { permission, origin, kinds, blocked, needPrompt })
  if (blocked) return false // any blocked kind denies the whole request

  const granted = needPrompt ? await promptForPermission(wc, partition, origin, kinds) : true
  if (!granted) return false
  // Granted at the app level — for media, the OS must agree too. This is also
  // why we must NOT use setPermissionCheckHandler (see installPermissionHandlers):
  // askForMediaAccess only runs on this request path.
  const osBlocked = await ensureOsMediaAccess(kinds)
  if (osBlocked.length > 0) {
    log.warn('permissions: granted in-app but OS denied media access', { origin, kinds: osBlocked })
    notifyOsMediaBlocked(wc, osBlocked)
    return false
  }
  return true
}

function installPermissionHandlers(ses: Electron.Session, partition: string): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    decidePermission(wc, permission, details as PermissionDetails | undefined, partition)
      .then(callback)
      .catch((err) => {
        log.warn('permissions: decide threw — denying', { permission, err: String(err) })
        callback(false)
      })
  })
  // Deliberately NO setPermissionCheckHandler. Electron's check handler is a
  // synchronous boolean with no "ask" state: returning false makes Chromium
  // reject getUserMedia *immediately* without ever calling the request handler
  // (so no prompt fires), and returning true makes Chromium treat the
  // permission as already-granted and *skip* the request handler (so the
  // macOS askForMediaAccess in decidePermission never runs and capture fails
  // silently at the OS layer). Leaving it unset lets media reach the request
  // handler, which is the only place we can both prompt and trigger the OS
  // permission. The trade-off — navigator.permissions.query not reflecting a
  // blocked site — is cosmetic; getUserMedia is still gated by the request
  // handler, which returns false for blocked kinds.
}

/** Called from the renderer (via ipc) when the user clicks Allow/Block on a
 *  permission prompt. `remember` persists the decision per (profile, origin,
 *  kind); a one-off dismiss leaves the default untouched so the site can ask
 *  again later. */
export function resolvePermissionRequest(
  requestId: string,
  decision: 'allow' | 'block',
  remember: boolean,
): void {
  const pending = pendingPermissions.get(requestId)
  if (!pending) return
  if (remember) {
    for (const kind of pending.kinds) {
      setGrant(pending.partition, pending.origin, kind, decision)
    }
  }
  pending.settle(decision === 'allow')
}

/** Configure a session: strip Electron branding from the UA, gate site
 *  permissions, apply proxy settings. Applied to both the default session and
 *  partitioned webview sessions. */
function configureSession(ses: Electron.Session, partition: string): void {
  const rawUA = ses.getUserAgent()
  const cleanUA = rawUA
    .replace(/\s*Electron\/\S+/g, '')
    .replace(/\s*newbro-browser\/\S+/g, '')
    .replace(/\s*Newbro\/\S+/g, '')
  ses.setUserAgent(cleanUA)
  installPermissionHandlers(ses, partition)
  // Listen for file downloads so the renderer's downloads panel can show
  // progress + history. Idempotent — guarded inside attachDownloadHandler.
  attachDownloadHandler(ses)
  applyProxyToSession(ses, loadSettings())
  // Restore the VPN extension's last-known proxy BEFORE any tab in this
  // partition starts navigating — otherwise tab loads that fire between
  // app start and Browsec's first setActualPac get aborted when our
  // applyProxyConfigToAllSessions runs closeAllConnections.
  applyPersistedExtensionProxyToSession(partition, ses)

  // Synchronously allow TLS handshakes for user-bypassed origins. This is
  // called for every request (including subresources like favicons and
  // images), while app.on('certificate-error') is async and unreliable for
  // subresources — the renderer's <img src="https://bad-cert/favicon.ico">
  // needs this to succeed after the user has clicked through the warning.
  //
  // Callback values (from Electron docs):
  //   0  = trust (skip further checks)
  //   -3 = use Chromium's default verification
  //   -2 = hard failure (do NOT use for "just defer to default" — it rejects!)
  ses.setCertificateVerifyProc((request, callback) => {
    try {
      if (bypassedCertOrigins.has(new URL(`https://${request.hostname}`).origin)) {
        callback(0)
        return
      }
    } catch {
      /* fall through */
    }
    callback(-3)
  })

  const externalFilter = { urls: ['http://*/*', 'https://*/*'] }

  // Track per-request the Origin header for fetches initiated from
  // chrome-extension:// contexts (SW + popup). Used by the
  // onHeadersReceived hook to inject matching CORS allow headers — Chrome
  // grants extension origins implicit CORS bypass for any URL listed in
  // host_permissions; Electron does not, so e.g. Browsec's `fetch(
  // https://www.google-analytics.com/...)` fails with "Failed to fetch"
  // because the response carries no Access-Control-Allow-Origin matching
  // the chrome-extension origin. We mirror Chrome's privilege by adding
  // the headers ourselves on the response.
  const extOriginByRequest = new Map<number, { origin: string; credentialed: boolean }>()

  ses.webRequest.onBeforeSendHeaders(externalFilter, (details, callback) => {
    const headers = { ...details.requestHeaders }
    delete headers['X-Electron-Version']
    const origin = headers['Origin'] ?? headers['origin']
    if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
      const credentialed = Boolean(headers['Cookie'] ?? headers['cookie'])
      extOriginByRequest.set(details.id, { origin, credentialed })
    }
    callback({ requestHeaders: headers })
  })

  ses.webRequest.onHeadersReceived(externalFilter, (details, callback) => {
    const tracked = extOriginByRequest.get(details.id)
    if (!tracked) {
      callback({})
      return
    }
    const headers: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(details.responseHeaders ?? {})) {
      const lower = k.toLowerCase()
      // Drop server-set CORS allow headers — we replace them so a "*"
      // doesn't conflict with our credentialed allow-origin (the spec
      // rejects credentialed requests against "*").
      if (
        lower === 'access-control-allow-origin' ||
        lower === 'access-control-allow-credentials' ||
        lower === 'access-control-allow-methods' ||
        lower === 'access-control-allow-headers' ||
        lower === 'access-control-expose-headers'
      ) continue
      headers[k] = Array.isArray(v) ? v : [String(v)]
    }
    headers['Access-Control-Allow-Origin'] = [tracked.origin]
    if (tracked.credentialed) {
      headers['Access-Control-Allow-Credentials'] = ['true']
    }
    headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH']
    headers['Access-Control-Allow-Headers'] = ['*']
    headers['Access-Control-Expose-Headers'] = ['*']
    callback({ responseHeaders: headers })
  })

  // Cleanup tracking map on terminal events. onCompleted/onErrorOccurred
  // both fire after the headers stage, so the map is consumed before
  // either runs.
  const dropTracked = (details: { id: number }): void => {
    extOriginByRequest.delete(details.id)
  }
  ses.webRequest.onCompleted(externalFilter, dropTracked)

  // Diagnostic: log network errors for any URL Browsec or other extensions
  // hit. Don't filter on the tracked origin map — onBeforeSendHeaders may
  // not see chrome-extension SW fetches at all on Electron 41 (the
  // tracking + CORS injection branch above relies on it firing). Logging
  // unconditionally for known extension targets confirms whether
  // webRequest fires at all for these requests.
  ses.webRequest.onErrorOccurred(externalFilter, (details) => {
    const tracked = extOriginByRequest.get(details.id)
    extOriginByRequest.delete(details.id)
    if (details.error === 'net::ERR_ABORTED') return
    // ERR_CACHE_MISS is a normal cache-cold miss on first load — Chromium
    // refetches and succeeds. Logging it as a failure is misleading.
    if (details.error === 'net::ERR_CACHE_MISS') return
    // Our SW shim's sentinel ping (newbro-ext-ipc.test/*) is cancelled on
    // purpose — webRequest reports it as ERR_BLOCKED_BY_CLIENT; that's a
    // success path, not a failure.
    if (details.error === 'net::ERR_BLOCKED_BY_CLIENT' && details.url.includes('newbro-ext-ipc.test')) return
    log.warn('ext fetch failed', {
      url: details.url,
      method: details.method,
      error: details.error,
      origin: tracked?.origin ?? '(untracked)',
    })
  })

  // Specifically capture errors on the SW IPC host AND the newbro-ipc://
  // scheme. fetch() inside a SW only surfaces "Failed to fetch" — the
  // real net::ERR_* code lives here. The previous handler filtered to
  // http(s) only and would fall through ERR_BLOCKED_BY_CLIENT for the
  // sentinel host (intentional cancel) without giving us visibility
  // into UNEXPECTED errors on those URLs.
  const ipcFilter = {
    urls: [
      'https://newbro-ext-ipc.test/*',
      'http://newbro-ext-ipc.test/*',
      'newbro-ipc://*/*',
    ],
  }
  ses.webRequest.onErrorOccurred(ipcFilter, (details) => {
    // Cancellation of fire-and-forget posts to newbro-ext-ipc.test is
    // by design (one-way IPC). Anything ELSE on these URLs is a real
    // problem worth logging — DNS, CORS, scheme policy, etc.
    if (
      details.error === 'net::ERR_BLOCKED_BY_CLIENT' &&
      details.url.includes('newbro-ext-ipc.test')
    ) return
    log.warn('newbro IPC fetch failed', {
      url: details.url,
      method: details.method,
      error: details.error,
      partition,
    })
  })
  ses.webRequest.onCompleted(ipcFilter, (details) => {
    // Track even successful IPC requests so we can correlate
    // "Failed to fetch" in the SW with what main actually did.
    log.info('newbro IPC fetch completed', {
      url: details.url,
      method: details.method,
      statusCode: details.statusCode,
      partition,
    })
  })


  // chrome.webRequest.onAuthRequired forwarding lives in
  // installLoginHandlerOnce() — registered ONCE on app, not per
  // session. The handler dispatches to a per-session partition via
  // webContents.session lookup. Earlier this was registered inside
  // configureSession(), so each new partition added another listener
  // and a single login fired N times → each parked its own timer
  // pointing at the SAME Electron callback → after 15s all timers
  // raced to invoke it, throwing "One-time callback was called more
  // than once."

  // SW → main IPC channel. The shim we prepend into MV3 service workers
  // can't import { ipcRenderer } from 'electron' (no preload bridge in
  // an extension's own JS world), so it talks to us by sending a
  // fetch() to a sentinel host. We intercept that fetch before any
  // network resolution happens, drive the requested action, and cancel
  // the request — the .test TLD never reaches DNS even if the cancel
  // races. Pattern stays narrow (one host) so legitimate requests are
  // untouched.
  // Custom protocol that the SW shim can fetch from to get JSON back.
  // The webRequest sentinel pattern is one-way (we cancel, no body),
  // which is fine for "open this tab" but doesn't help when the SW
  // needs to ask "what's the URL of the active tab?" — that needs a
  // round-trip with content. protocol.handle returns a real Response.
  try {
    const handle = (ses.protocol as { handle?: (scheme: string, h: (req: Request) => Promise<Response> | Response) => void }).handle
    if (typeof handle === 'function') {
      handle.call(ses.protocol, 'newbro-ipc', async (req: Request): Promise<Response> => {
        try {
          const u = new URL(req.url)
          const action = u.hostname || u.pathname.replace(/^\/+/, '')
          // Trace every reach into the protocol handler. If the SW
          // says "Failed to fetch" but we don't see this log line, the
          // failure is BEFORE the handler runs (CORS preflight, scheme
          // policy, etc.). If we DO see it, the failure is in our
          // response shape or the SW's reading of it.
          log.info('extensions: newbro-ipc request', {
            partition,
            action,
            method: req.method,
            url: req.url.slice(0, 200),
          })
          // CORS preflight — Chromium fires OPTIONS before non-simple
          // POSTs across origins. Without explicit handling here the
          // preflight rejects and the actual POST never happens, so
          // auth-respond never reaches main.
          if (req.method === 'OPTIONS') {
            return new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
              },
            })
          }
          if (action === 'active-tab-info' || action === 'active-tab-info/') {
            // Find the workspace window that owns this partition. We
            // pick the focused one; if none is focused, the first
            // window with a tab in this partition.
            const win = pickWindowForPartition(partition)
            if (!win) {
              log.info('extensions: ipc active-tab-info — no window for partition', { partition })
              return jsonResponse({ tab: null })
            }
            const tab = getActiveTabInfoForWindow(win.id)
            log.info('extensions: ipc active-tab-info', { partition, windowId: win.id, tab })
            return jsonResponse({ tab })
          }
          if (action === 'auth-poll' || action === 'auth-poll/') {
            // SW long-polls here for a pending webRequest.onAuthRequired
            // challenge. Resolve with the next available challenge for
            // this partition, or wait up to 30s for one to arrive.
            return waitForAuthChallenge(partition, 30000)
          }
          if (action === 'auth-respond' || action === 'auth-respond/') {
            // SW POSTs credentials/cancel back here. Match by
            // challengeId, fire the webRequest callback held in main.
            const body = await req.text()
            try {
              const parsed = JSON.parse(body) as { challengeId?: string; response?: { authCredentials?: { username?: string; password?: string }; cancel?: boolean } }
              if (parsed && typeof parsed.challengeId === 'string') {
                resolveAuthChallenge(parsed.challengeId, parsed.response ?? {})
              }
            } catch (err) {
              log.warn('extensions: auth-respond body parse failed', { partition, err: String(err) })
            }
            return jsonResponse({ ok: true })
          }
          return jsonResponse({ error: 'unknown-action', action })
        } catch (err) {
          return jsonResponse({ error: String(err) }, 500)
        }
      })
    } else {
      log.warn('extensions: ses.protocol.handle missing — SW newbro-ipc:// won\'t work', { partition })
    }
  } catch (err) {
    log.warn('extensions: ses.protocol.handle setup failed', { partition, err: String(err) })
  }

  ses.webRequest.onBeforeRequest(
    { urls: ['https://newbro-ext-ipc.test/*', 'http://newbro-ext-ipc.test/*'] },
    (details, callback) => {
      try {
        const u = new URL(details.url)
        const action = u.pathname.replace(/^\/+/, '')

        // Round-trip actions (auth-poll, auth-respond, active-tab-info)
        // moved off this channel — they go to the loopback HTTP server
        // started in app.whenReady (sw-rpc-server.ts). webRequest's
        // cancel-bound transport can't deliver a response body, and
        // the data:-URL-redirect alternative was rejected with
        // ERR_UNSAFE_REDIRECT by Chromium's net stack.

        if (action === 'open-tab') {
          const url = u.searchParams.get('url')
          if (typeof url === 'string' && url.length > 0) {
            const focused = BrowserWindow.getFocusedWindow()
            const target =
              focused && !focused.isDestroyed()
                ? focused
                : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
            if (target) {
              try { closeExtensionPopup(target.id) }
              catch (err) { log.warn('extensions: closeExtensionPopup before open-tab', { err: String(err) }) }
              target.webContents.send('open-url-as-tab', url)
              log.info('extensions: SW shim opened tab', { url })
            }
          }
        } else if (action === 'userscripts-register' || action === 'userscripts-update') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; scripts?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const scripts = Array.isArray(p.scripts) ? (p.scripts as RegisteredUserScript[]) : []
            if (extId && scripts.length > 0) {
              registerUserScripts(getPartitionForSession(ses), extId, scripts)
            }
          }
        } else if (action === 'userscripts-unregister') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; ids?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const ids = Array.isArray(p.ids) ? (p.ids as string[]) : null
            if (extId) unregisterUserScripts(getPartitionForSession(ses), extId, ids)
          }
        } else if (action === 'proxy-settings-set') {
          // Browsec / Hola / VPN-style extensions call
          // chrome.proxy.settings.set({ value: <chrome.proxy.config> }).
          // Convert to Electron's session.setProxy() shape and apply
          // to every partitioned session in this profile so all tabs
          // route through the new proxy.
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { value?: unknown; extId?: unknown }
            const cfg = chromeProxyToElectron(p.value)
            if (cfg) {
              log.info('extensions: chrome.proxy.settings.set', {
                extId: p.extId,
                cfg,
              })
              applyProxyConfigToAllSessions(cfg)
            } else {
              log.warn('extensions: chrome.proxy.settings.set — could not parse value', {
                extId: p.extId, value: p.value,
              })
            }
          }
        } else if (action === 'proxy-settings-clear') {
          log.info('extensions: chrome.proxy.settings.clear — reverting to system')
          applyProxyConfigToAllSessions({ mode: 'system' })
        } else if (action === 'storage-bridge') {
          // Popup (or any non-SW context) writes to chrome.storage.local;
          // Electron 41 fires onChanged in the writing context only, so
          // the SW never sees the change. The frame-side preload posts
          // each onChanged payload here; we queue per extId and the SW
          // shim drains via /storage-poll. See SwRpcRoutes.storagePoll.
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; areaName?: unknown; changes?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const areaName = typeof p.areaName === 'string' ? p.areaName : 'local'
            const changes = (p.changes && typeof p.changes === 'object') ? (p.changes as Record<string, unknown>) : {}
            const keys = Object.keys(changes)
            if (extId && keys.length > 0) {
              log.info('extensions: storage-bridge fwd', {
                partition: getPartitionForSession(ses),
                extId,
                areaName,
                keys,
              })
              enqueueStorageChange(extId, areaName, changes)
            }
          }
        } else if (
          action === 'sw-shim-ran' ||
          action === 'post-patch-state' ||
          action === 'userscripts-shim-state' ||
          action === 'webRequest-onAuthRequired-add' ||
          action === 'patch-step' ||
          action === 'chrome-access' ||
          action === 'fetch-start' ||
          action === 'fetch-end' ||
          action === 'fetch-error' ||
          action === 'ws-open' ||
          action === 'bg-source-window' ||
          action === 'sw-error' ||
          action === 'runtime-onStartup-check' ||
          action === 'runtime-event-onMessage' ||
          action === 'runtime-event-onConnect' ||
          action === 'storage-bridge-recv' ||
          action === 'storage-onChanged-missing' ||
          action === 'storage-bridge-mainworld-installed' ||
          action === 'storage-bridge-mainworld-gaveup' ||
          action === 'sw-shim-error' ||
          action === 'wrap-chrome-diag' ||
          action === 'chrome-access-miss' ||
          action === 'userscript-setup-installed' ||
          action === 'userscript-setup-entry'
        ) {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          log.info('extensions: ' + action, {
            partition: getPartitionForSession(ses),
            info: parsed,
          })
          // When the SW crashed, also dump a window of the bundle around
          // the exact column so we can see what the offending call says.
          // Without this we just have line+column of a 1.5MB minified line.
          if (action === 'sw-error' && parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; lineno?: unknown; colno?: unknown }
            const eid = typeof p.extId === 'string' ? p.extId : ''
            const ln = typeof p.lineno === 'number' ? p.lineno : 0
            const cn = typeof p.colno === 'number' ? p.colno : 0
            if (eid && ln > 0 && cn > 0) {
              const slice = readBgSourceWindow(eid, ln, cn, 320)
              if (slice) log.info('extensions: sw-error-source', { slice })
            }
          }
        } else if (
          action === 'userscripts-getScripts' ||
          action === 'userscripts-configureWorld'
        ) {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          log.info('extensions: ' + action, {
            partition: getPartitionForSession(ses),
            info: parsed,
          })
        } else if (action === 'permission-check') {
          // Diagnostic from the SW shim's chrome.permissions.contains.
          // Surfaces what URL/permissions Tampermonkey is gating on.
          log.info('extensions: permission-check (SW)', {
            origins: u.searchParams.get('origins') ?? '',
            permissions: u.searchParams.get('permissions') ?? '',
          })
        } else if (action === 'scripting-execute') {
          const body = readUploadBody(details)
          const parsed = body ? safeJsonParse(body) : null
          if (parsed && typeof parsed === 'object') {
            const p = parsed as { extId?: unknown; tabIds?: unknown; body?: unknown; world?: unknown }
            const extId = typeof p.extId === 'string' ? p.extId : ''
            const tabIds = Array.isArray(p.tabIds) ? (p.tabIds as number[]) : []
            const code = typeof p.body === 'string' ? p.body : ''
            log.info('extensions: scripting-execute', { extId, tabIds, codeLen: code.length })
            // Inject the code into every requested tab. Tab ids passed
            // by the SW shim come from our hashed UUIDs (see
            // tab-views.ts hashStringToInt) — find each matching tab
            // and run its code.
            if (code.length > 0 && tabIds.length > 0) {
              executeScriptOnHashedTabIds(getPartitionForSession(ses), tabIds, code)
            }
          }
        } else if (action === 'badge-set' || action === 'badge-color') {
          // Forward to every workspace renderer so it can update its
          // toolbar icon overlay. Renderer-side rendering ships in a
          // follow-up commit; for now we just log + broadcast.
          const extId = u.searchParams.get('extId') ?? ''
          const text = u.searchParams.get('text') ?? ''
          const color = u.searchParams.get('color') ?? ''
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) {
              w.webContents.send('extensions:badge', { extId, text, color, action })
            }
          }
        }
      } catch (err) {
        log.warn('extensions: SW shim ipc parse failed', { url: details.url, err: String(err) })
      }
      callback({ cancel: true })
    },
  )
}

function readUploadBody(details: Electron.OnBeforeRequestListenerDetails): string | null {
  const data = details.uploadData
  if (!Array.isArray(data) || data.length === 0) return null
  let out = ''
  for (const part of data) {
    const bytes = (part as { bytes?: Buffer }).bytes
    if (bytes && Buffer.isBuffer(bytes)) out += bytes.toString('utf8')
  }
  return out.length > 0 ? out : null
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

function getPartitionForSession(ses: Electron.Session): string {
  for (const partition of configuredPartitions) {
    if (session.fromPartition(partition) === ses) return partition
  }
  return 'persist:default'
}

/** Translate chrome.proxy.config (passed by the extension) into the
 *  Electron ProxyConfig shape. Returns null when the input doesn't
 *  parse — caller logs and falls back to system. */
function chromeProxyToElectron(value: unknown): Electron.ProxyConfig | null {
  if (!value || typeof value !== 'object') return null
  const v = value as {
    mode?: string
    rules?: {
      singleProxy?: { scheme?: string; host?: string; port?: number }
      proxyForHttp?: { scheme?: string; host?: string; port?: number }
      proxyForHttps?: { scheme?: string; host?: string; port?: number }
      proxyForFtp?: { scheme?: string; host?: string; port?: number }
      fallbackProxy?: { scheme?: string; host?: string; port?: number }
      bypassList?: string[]
    }
    pacScript?: { url?: string; data?: string; mandatory?: boolean }
  }
  const mode = String(v.mode ?? '').toLowerCase()

  const fmtServer = (s?: { scheme?: string; host?: string; port?: number }): string | null => {
    if (!s || !s.host) return null
    const scheme = (s.scheme ?? 'http').toLowerCase()
    const port = typeof s.port === 'number' ? `:${s.port}` : ''
    return `${scheme}://${s.host}${port}`
  }

  if (mode === 'direct') return { mode: 'direct' }
  if (mode === 'system') return { mode: 'system' }
  if (mode === 'auto_detect') return { mode: 'auto_detect' }
  if (mode === 'pac_script') {
    if (v.pacScript?.url) return { mode: 'pac_script', pacScript: v.pacScript.url }
    if (typeof v.pacScript?.data === 'string' && v.pacScript.data.length > 0) {
      // Browsec/Hola/etc. ship the PAC body inline rather than hosting
      // it. Electron's setProxy only accepts a URL, but Chrome's network
      // stack treats a base64 data: URI the same as a fetched script.
      // Base64 because the PAC body contains arbitrary characters and
      // grows to ~300KB — URL-encoding would balloon further; base64 is
      // ~33% overhead and well under Chromium's data-URI ceiling.
      const b64 = Buffer.from(v.pacScript.data, 'utf8').toString('base64')
      return {
        mode: 'pac_script',
        pacScript: `data:application/x-ns-proxy-autoconfig;base64,${b64}`,
      }
    }
    return null
  }
  if (mode === 'fixed_servers') {
    const rules = v.rules ?? {}
    const parts: string[] = []
    const single = fmtServer(rules.singleProxy)
    if (single) {
      // singleProxy applies to all schemes
      parts.push(single)
    } else {
      const http = fmtServer(rules.proxyForHttp)
      const https = fmtServer(rules.proxyForHttps)
      const ftp = fmtServer(rules.proxyForFtp)
      const fallback = fmtServer(rules.fallbackProxy)
      if (http) parts.push(`http=${http}`)
      if (https) parts.push(`https=${https}`)
      if (ftp) parts.push(`ftp=${ftp}`)
      if (fallback) parts.push(fallback)
    }
    if (parts.length === 0) return null
    const proxyRules = parts.join(';')
    const proxyBypassRules = Array.isArray(rules.bypassList) && rules.bypassList.length > 0
      ? rules.bypassList.join(',')
      : '<-loopback>'
    return { mode: 'fixed_servers', proxyRules, proxyBypassRules }
  }
  return null
}

// Note: prior versions of this file had a `handleIpcRoundTrip` helper
// that tried to deliver round-trip responses by redirecting the SW's
// fetch to a `data:application/json,...` URL via webRequest. That
// approach is dead — Chromium's net stack rejects HTTPS-to-data:
// redirects with ERR_UNSAFE_REDIRECT. The replacement is a real
// loopback HTTP server (sw-rpc-server.ts).

/** Bypass list we ALWAYS append to whatever an extension supplies, so
 *  Newbro's own machinery never gets routed through a VPN proxy by
 *  accident. The newbro-ext-ipc.test sentinel host is the channel our
 *  SW shim uses to talk back to main; if a PAC script swallows that
 *  fetch (Browsec's PAC has no idea what newbro-ext-ipc is and routes
 *  it through some random server), the SW's diagnostic stream goes
 *  silent and we lose every fetch-error / sw-error / patch-step beacon.
 *  loopback covers localhost and 127.0.0.1 for dev-server / IPC ports. */
const NEWBRO_PROXY_BYPASS = 'newbro-ext-ipc.test;<-loopback>'

/** Merge the extension-supplied bypass list with our mandatory entries.
 *  Idempotent — adding our markers twice is harmless to Chromium's
 *  parser, but we still de-dupe for clean logs. */
function withNewbroBypass(extensionBypass: string | undefined): string {
  if (!extensionBypass) return NEWBRO_PROXY_BYPASS
  // Bypass-rule separator in Chromium is ';' (also accepts ',' but
  // we normalize to ';' on output).
  const parts = new Set(
    (extensionBypass + ';' + NEWBRO_PROXY_BYPASS)
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
  return Array.from(parts).join(';')
}

/** Apply a proxy config to every CONFIGURED PARTITION session. Used
 *  by chrome.proxy.settings.set/clear forwarding so VPN extensions can
 *  actually route traffic.
 *
 *  Notably skips session.defaultSession: that one is the Newbro UI
 *  shell (toolbar, sidebar, dropdown windows). User browsing happens
 *  in profile partitions. Putting Browsec's PAC on the default session
 *  caused Newbro's own UI to attempt proxy auth — fired login events
 *  for partition 'persist:default' that no SW could ever answer (no
 *  extension lives in that session), wedging the auth pipeline with
 *  doomed-to-timeout challenges.
 *
 *  ALWAYS forces our newbro-ext-ipc.test host into the bypass list —
 *  without it the SW shim's IPC channel back to main goes through
 *  whatever proxy the extension installed and dies on Failed to
 *  fetch, taking out our entire diagnostic pipeline. */
/** Last extension-driven proxy config applied per partition. Drives two
 *  things:
 *    - Dedup: chrome.proxy.settings.set fires repeatedly at SW boot
 *      (Browsec calls setActualPac at least twice in the first second).
 *      A second `ses.setProxy + closeAllConnections` cycle with the
 *      same PAC kills any in-flight tab load (ya.ru ERR_FAILED) for
 *      no benefit. Compare the JSON before re-applying.
 *    - Persistence: the cfg is mirrored to disk so the NEXT launch can
 *      restore the proxy BEFORE any tab navigates. Without that the SW
 *      hasn't booted yet when the workspace's tabs start loading, and
 *      they race against Browsec's first setActualPac. */
const lastExtensionProxyByPartition = new Map<string, Electron.ProxyConfig>()
const EXTENSION_PROXY_STORE_PATH = (): string =>
  join(app.getPath('userData'), 'newbro-extension-proxy.json')

function persistExtensionProxy(): void {
  try {
    const obj: Record<string, Electron.ProxyConfig> = {}
    for (const [k, v] of lastExtensionProxyByPartition) obj[k] = v
    require('fs').writeFileSync(EXTENSION_PROXY_STORE_PATH(), JSON.stringify(obj, null, 2))
  } catch (err) {
    log.warn('extensions: persistExtensionProxy failed', { err: String(err) })
  }
}

function loadPersistedExtensionProxy(): Record<string, Electron.ProxyConfig> {
  try {
    const fs = require('fs') as typeof import('fs')
    const path = EXTENSION_PROXY_STORE_PATH()
    if (!fs.existsSync(path)) return {}
    const raw = fs.readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, Electron.ProxyConfig>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    log.warn('extensions: loadPersistedExtensionProxy failed', { err: String(err) })
    return {}
  }
}

/** Apply the persisted extension proxy (if any) to a freshly-configured
 *  partition session. Called from configureSession AFTER the default
 *  applyProxyToSession run, so we override the user's manual settings
 *  with the SW's last-known cfg — but only if there IS one. New users
 *  get default-system behavior; returning Browsec users get their VPN
 *  active from the very first paint. */
function applyPersistedExtensionProxyToSession(partition: string, ses: Electron.Session): void {
  const persisted = loadPersistedExtensionProxy()[partition]
  if (!persisted) return
  const merged: Electron.ProxyConfig = {
    ...persisted,
    proxyBypassRules: withNewbroBypass(persisted.proxyBypassRules),
  }
  lastExtensionProxyByPartition.set(partition, merged)
  ses.setProxy(merged)
    .then(async () => {
      await ses.forceReloadProxyConfig()
      log.info('extensions: restored persisted proxy at session setup', {
        partition,
        mode: merged.mode,
      })
    })
    .catch((err) => log.warn('extensions: persisted proxy restore failed', { partition, err: String(err) }))
}

function applyProxyConfigToAllSessions(cfg: Electron.ProxyConfig): void {
  const merged: Electron.ProxyConfig = {
    ...cfg,
    proxyBypassRules: withNewbroBypass(cfg.proxyBypassRules),
  }
  // Snapshot to disk every time — cheap and covers app crashes.
  let anyChanged = false
  for (const partition of configuredPartitions) {
    const ses = session.fromPartition(partition)
    const prior = lastExtensionProxyByPartition.get(partition)
    const sameAsPrior = prior && JSON.stringify(prior) === JSON.stringify(merged)
    if (sameAsPrior) continue
    anyChanged = true
    lastExtensionProxyByPartition.set(partition, merged)
    ses.setProxy(merged)
      .then(async () => {
        // See applyProxyToSession for why we don't closeAllConnections
        // here — TL;DR ya.ru's workspace-restore navigation races against
        // Browsec's first setActualPac and gets aborted (ERR_FAILED).
        // forceReloadProxyConfig is enough; new requests use the fresh
        // PAC, in-flight ones keep their existing routing.
        await ses.forceReloadProxyConfig()
      })
      .catch((err) => log.warn('extensions: applyProxyConfigToAllSessions failed', { partition, err: String(err) }))
  }
  if (anyChanged) persistExtensionProxy()
}

/** registerPreloadScript replaces the deprecated setPreloads. Idempotent
 *  per `id`: re-registering the same id silently returns. We use this
 *  instead of setPreloads so partitioned sessions get the new API
 *  surface AND so we can target frame vs service-worker contexts
 *  explicitly. Falls back to setPreloads only if the new API isn't
 *  exposed (very old Electron). */
function registerFramePreload(ses: Electron.Session, filePath: string, id: string): void {
  try {
    const reg = (ses as unknown as {
      registerPreloadScript?: (spec: { type: 'frame' | 'service-worker'; filePath: string; id?: string }) => string | void
    }).registerPreloadScript
    if (typeof reg === 'function') {
      reg.call(ses, { type: 'frame', filePath, id })
      return
    }
  } catch (err) {
    log.warn('extensions: registerPreloadScript(frame) failed', { id, err: String(err) })
  }
  // Fallback for Electron < 35.
  try {
    const setPreloads = (ses as unknown as { setPreloads?: (paths: string[]) => void }).setPreloads
    const getPreloads = (ses as unknown as { getPreloads?: () => string[] }).getPreloads
    if (typeof setPreloads === 'function') {
      const existing = typeof getPreloads === 'function' ? getPreloads.call(ses) : []
      if (!existing.includes(filePath)) setPreloads.call(ses, [...existing, filePath])
    }
  } catch (err) {
    log.warn('extensions: setPreloads fallback failed', { id, err: String(err) })
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // SW fetches cross-origin (chrome-extension:// → newbro-ipc://)
      // and Chromium enforces CORS on the response read even though
      // the scheme is registered with corsEnabled. Without these
      // headers the response body is opaque and the SW's auth-poll
      // .then(r => r.json()) sees nothing, so it can't dispatch
      // challenges.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    },
  })
}

/** Patch electron-chrome-extensions's preload so chrome.action.setIcon
 *  with imageData (canvas-rendered icons) actually reaches the main
 *  process in MV3. Without this, every runtime icon update from a
 *  canvas-backed extension is dropped:
 *
 *    1. Library's preload strips imageData on MV3 with a console.warn —
 *       MV2 has a sync canvas → toDataURL helper but it uses
 *       `document.createElement('canvas')` which throws in a SW context.
 *    2. We replace the helper with an OffscreenCanvas + convertToBlob
 *       async path, valid in both frame and SW contexts.
 *    3. invokeExtension's serialize callback runs synchronously today.
 *       We promote it to await so the new async helper can land before
 *       the IPC fires.
 *
 *  All three edits must succeed — the patch refuses to write when any
 *  replacement misses (library version drifted) so we don't ship a
 *  half-patched file. Idempotent via the V2 marker. */
function patchLibraryPreloadForMV3SetIcon(): void {
  log.info('extensions: setIcon-patch begin')
  // Try multiple strategies to resolve the preload path. Vite's externalize
  // keeps the require call live, but production bundles can sometimes
  // strip require.resolve unexpectedly — fall back to walking from the
  // app's resource path so we always find the file.
  const candidates: string[] = []
  try {
    candidates.push(
      join(
        require.resolve('electron-chrome-extensions'),
        '..',
        '..',
        'chrome-extension-api.preload.js',
      ),
    )
  } catch (err) {
    log.warn('extensions: setIcon-patch require.resolve threw', String(err))
  }
  try {
    candidates.push(
      join(
        app.getAppPath(),
        'node_modules',
        'electron-chrome-extensions',
        'dist',
        'chrome-extension-api.preload.js',
      ),
    )
  } catch (err) {
    log.warn('extensions: setIcon-patch packaged-candidate join failed', { err: String(err) })
  }
  // dev: app.getAppPath() points at out/main; node_modules is two up.
  try {
    candidates.push(
      join(
        app.getAppPath(),
        '..',
        '..',
        'node_modules',
        'electron-chrome-extensions',
        'dist',
        'chrome-extension-api.preload.js',
      ),
    )
  } catch (err) {
    log.warn('extensions: setIcon-patch dev-candidate join failed', { err: String(err) })
  }
  let preloadPath: string | null = null
  const probeFailures: Array<{ candidate: string; err: string }> = []
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf-8')
      preloadPath = c
      break
    } catch (err) {
      probeFailures.push({ candidate: c, err: String(err) })
    }
  }
  if (!preloadPath) {
    log.warn('extensions: setIcon-patch — no candidate readable', { tried: probeFailures })
  }
  if (!preloadPath) {
    log.warn('extensions: setIcon-patch could not locate preload', { candidates })
    return
  }
  log.info('extensions: setIcon-patch resolved', { path: preloadPath })
  let source: string
  try {
    source = readFileSync(preloadPath, 'utf-8')
  } catch (err) {
    log.warn('extensions: cannot read preload for MV3-setIcon patch', { path: preloadPath, err: String(err) })
    return
  }
  if (source.startsWith('// __NEWBRO_PRELOAD_PATCH_V2__')) {
    log.info('extensions: setIcon-patch already applied, skip')
    return
  }
  // Strip a stale V1 marker if a previous launch laid one down.
  source = source.replace(/^\/\/ __NEWBRO_PRELOAD_PATCH_V1__\n/, '')

  // Patches 1-3 below. Each replaceOnce returns a result + matched flag,
  // and the whole patch only commits when all three matched.
  const replaceOnce = (input: string, find: string, replace: string): { out: string; ok: boolean } => {
    const idx = input.indexOf(find)
    if (idx < 0) return { out: input, ok: false }
    return { out: input.slice(0, idx) + replace + input.slice(idx + find.length), ok: true }
  }

  // 1) Replace imageData2base64 with a SW-aware async version. OffscreenCanvas
  //    is available in MV3 service worker globals; document is not.
  const oldHelper =
`      function imageData2base64(imageData) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL();
      }`
  const newHelper =
`      async function imageData2base64(imageData) {
        try {
          if (typeof document !== "undefined" && document.createElement) {
            const c = document.createElement("canvas");
            const cx = c.getContext("2d");
            if (!cx) return null;
            c.width = imageData.width;
            c.height = imageData.height;
            cx.putImageData(imageData, 0, 0);
            return c.toDataURL();
          }
          if (typeof OffscreenCanvas !== "undefined") {
            const oc = new OffscreenCanvas(imageData.width, imageData.height);
            const ox = oc.getContext("2d");
            if (!ox) return null;
            ox.putImageData(imageData, 0, 0);
            const blob = await oc.convertToBlob({ type: "image/png" });
            const buf = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return "data:image/png;base64," + btoa(bin);
          }
          return null;
        } catch (e) { return null; }
      }`

  // 2) Replace the setIcon serialize block: drop the MV3 strip and await
  //    the now-async helper for both the single-ImageData and the size-keyed
  //    map cases. Using a for-loop instead of Array.reduce so we can await.
  const oldSetIcon =
`          setIcon: invokeExtension2("browserAction.setIcon", {
            serialize: (details) => {
              if (details.imageData) {
                if (manifest.manifest_version === 3) {
                  console.warn(
                    "action.setIcon with imageData is not yet supported by electron-chrome-extensions"
                  );
                  details.imageData = void 0;
                } else if (details.imageData instanceof ImageData) {
                  details.imageData = imageData2base64(details.imageData);
                } else {
                  details.imageData = Object.entries(details.imageData).reduce(
                    (obj, pair) => {
                      obj[pair[0]] = imageData2base64(pair[1]);
                      return obj;
                    },
                    {}
                  );
                }
              }
              return [details];
            }
          }),`
  const newSetIcon =
`          setIcon: invokeExtension2("browserAction.setIcon", {
            serialize: async (details) => {
              if (details.imageData) {
                if (typeof ImageData !== "undefined" && details.imageData instanceof ImageData) {
                  details.imageData = await imageData2base64(details.imageData);
                } else if (typeof details.imageData === "object") {
                  const out = {};
                  const entries = Object.entries(details.imageData);
                  for (const [k, v] of entries) {
                    out[k] = await imageData2base64(v);
                  }
                  details.imageData = out;
                }
              }
              return [details];
            }
          }),`

  // 3) invokeExtension was synchronous through serialize. Make it await so
  //    the async setIcon serialize lands before the IPC.
  const oldInvoke =
`      if (options.serialize) {
        args = options.serialize(...args);
      }`
  const newInvoke =
`      if (options.serialize) {
        args = await Promise.resolve(options.serialize(...args));
      }`

  const r1 = replaceOnce(source, oldHelper, newHelper)
  const r2 = replaceOnce(r1.out, oldSetIcon, newSetIcon)
  const r3 = replaceOnce(r2.out, oldInvoke, newInvoke)

  if (!r1.ok || !r2.ok || !r3.ok) {
    log.warn('extensions: MV3-setIcon patch did not match — library version drifted', {
      path: preloadPath,
      helperMatched: r1.ok,
      setIconMatched: r2.ok,
      invokeMatched: r3.ok,
    })
    return
  }

  const patched = '// __NEWBRO_PRELOAD_PATCH_V2__\n' + r3.out
  try {
    writeFileSync(preloadPath, patched)
    log.info('extensions: patched library preload for MV3 setIcon imageData')
  } catch (err) {
    log.warn('extensions: cannot write patched preload', { path: preloadPath, err: String(err) })
  }
}

// patchLibraryPermissionsAPI was moved to ./extensions/patch-lib-deps.ts
// because it must run BEFORE `electron-chrome-extensions` is required —
// in app.whenReady the lib was already in Node's require cache, so the
// disk patch only took effect on the next launch. Side-effect import at
// the top of this file (`import './extensions/patch-lib-deps'`) runs at
// module load, before any `import { ElectronChromeExtensions }`.

/** Patterns matched against extension SW + popup console.log/info messages.
 *  Returns true when the message is known noise we'd rather not flood the
 *  main log with. Errors and warnings (level >= 2) bypass this filter.
 *  Be conservative — keep status messages we may need to triage what
 *  Browsec / Tampermonkey is actually doing. */
const EXT_CONSOLE_NOISE_REGEXES = [
  /^alarm: schedule\[/, // Tampermonkey scheduler chatter
  /^\[gaDigest\//, // Browsec GA4 digest noise
  /^\[jitsu\],/, // Browsec jitsu events (frequent)
  /^\[gaUserIdPromise\]/, // Browsec analytics id
  /^\[initial state:/, // Browsec massive PAC dump (~3KB)
  /^\[storageListener\]/, // Browsec storage echoes
  /^Local delay\./, // Browsec timing
  /^Delay\./, // Browsec timing
]
export function shouldDropExtConsoleMessage(message: string): boolean {
  // Browsec prefixes its own logs with `[dd, hh:mm:ss.mmm], `. Strip
  // before matching so the regexes can target message content directly.
  const stripped = message.replace(/^\[\d+,\s*\d+:\d+:\d+\.\d+\],\s*/, '')
  for (const re of EXT_CONSOLE_NOISE_REGEXES) if (re.test(stripped)) return true
  return false
}

function executeScriptOnHashedTabIds(partition: string, hashedTabIds: number[], code: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const view of win.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (!wc || wc.isDestroyed()) continue
      if (wc.session !== session.fromPartition(partition)) continue
      // Cross-reference via a fresh getActiveTabInfoForWindow call —
      // its return value carries the same hashed id the SW shim
      // would have received from chrome.tabs.query, so a match here
      // means we're operating on the right WebContentsView.
      const info = getActiveTabInfoForWindow(win.id)
      if (info && hashedTabIds.includes(info.id)) {
        wc.executeJavaScript(code, true).catch((err) => {
          log.warn('scripting-execute: injection failed', { err: String(err) })
        })
      }
    }
  }
}

/** Pick the partition session to use for SW-originated chrome.cookies
 *  calls. The SW shim source on disk is shared across partitions for the
 *  same extension (same bytes everywhere; per-partition substitution
 *  would invalidate Chromium's SW byte-cache, so we deliberately don't
 *  do it). That means the SW doesn't reliably know which partition it
 *  belongs to. Heuristic: prefer the focused workspace window's
 *  partition; fall back to the first configured partition. Good enough
 *  for single-profile usage. Multi-profile users will see cookies routed
 *  through the focused profile, which matches the rough Chrome mental
 *  model ("active profile gets the action"). */
function pickCookiesSession(): Electron.Session | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) {
    const partition = partitionForBrowserWindow(focused)
    if (partition) return session.fromPartition(partition)
  }
  const first = Array.from(configuredPartitions)[0]
  if (first) return session.fromPartition(first)
  return null
}

/** Convert Electron's Cookie shape to chrome.cookies.Cookie. The two
 *  differ in field names and some optional fields. */
function toCookieDetails(c: Electron.Cookie): Record<string, unknown> {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    session: !!c.session,
    expirationDate: c.expirationDate,
    storeId: '0',
  }
}

function pickWindowForPartition(partition: string): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) {
    for (const view of focused.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (wc && !wc.isDestroyed() && wc.session === session.fromPartition(partition)) {
        return focused
      }
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    for (const view of win.contentView.children) {
      const wc = (view as unknown as { webContents?: Electron.WebContents }).webContents
      if (wc && !wc.isDestroyed() && wc.session === session.fromPartition(partition)) {
        return win
      }
    }
  }
  return null
}

export function setupPartitionSession(partition: string): void {
  if (configuredPartitions.has(partition)) return
  // Idempotent — only the first partition setup actually attaches the
  // listener. Must be called BEFORE configuredPartitions.add(partition)
  // below, but the listener body itself uses configuredPartitions to
  // resolve the partition string from a session, so the order between
  // installLoginHandlerOnce and the add is irrelevant — only that the
  // listener exists by the time a login fires.
  installLoginHandlerOnce()
  const ses = session.fromPartition(partition)
  configureSession(ses, partition)
  // Only partitioned tab sessions get the stealth preload — the default
  // session belongs to the main renderer which doesn't need (and shouldn't
  // have) page-fingerprint overrides. The extension shim runs alongside
  // it; both self-disable on URLs outside their target scheme.
  // Use registerPreloadScript (Electron 35+) instead of setPreloads
  // (deprecated). The new API additionally lets us scope to frames vs
  // service workers explicitly.
  registerFramePreload(ses, WEBVIEW_STEALTH_PRELOAD, 'newbro-stealth')
  registerFramePreload(ses, EXTENSION_SHIM_PRELOAD, 'newbro-extension-shim')
  // The shim ALSO needs to run inside MV3 service workers, where most
  // extensions (Tampermonkey's icon-click handler in particular) host
  // their chrome.tabs.create calls. registerPreloadScript with
  // type='service-worker' is the API for that. Wrapped in try/catch
  // because the option name has shifted across Electron versions and we
  // don't want a missing API to break the partition.
  try {
    const ext = (ses as unknown as {
      registerPreloadScript?: (spec: {
        type: 'service-worker' | 'frame'
        filePath: string
        id?: string
      }) => string | void
    }).registerPreloadScript
    if (typeof ext === 'function') {
      ext.call(ses, {
        type: 'service-worker',
        filePath: EXTENSION_SHIM_PRELOAD,
        id: 'newbro-extension-shim-sw',
      })
      log.info('extensions: registered SW shim preload', { partition })
    } else {
      log.warn('extensions: ses.registerPreloadScript missing — SW shim won\'t inject', { partition })
    }
  } catch (err) {
    log.warn('extensions: registerPreloadScript(service-worker) failed', { partition, err: String(err) })
  }
  // Mirror chrome-extension service-worker console messages into the
  // main log. We KEEP:
  //   - everything at level 2+ (warnings, errors)
  //   - level 0/1 messages from the extension's own background.js
  //     (sourceUrl set) — those are extension-author logs we care about
  // We DROP:
  //   - level 0/1 messages with no sourceUrl (`url === ''`) — that's
  //     electron-chrome-extensions' own internal debug logging
  //     (tabs.query / tabs.onActivated / browserAction.setIcon spam,
  //     fires hundreds of times per startup)
  //   - the 30-second `extension.isAllowedFileSchemeAccess` flood
  try {
    const sw = (ses as unknown as { serviceWorkers?: { on?: Function } }).serviceWorkers
    if (sw && typeof sw.on === 'function') {
      sw.on(
        'console-message',
        (
          _e: unknown,
          details: { message?: string; sourceUrl?: string; level?: number },
        ) => {
          const msg = String(details?.message ?? '')
          if (msg.includes('extension.isAllowedFileSchemeAccess is not yet implemented')) return
          const url = String(details?.sourceUrl ?? '')
          const level = details?.level ?? 0
          // Library-internal debug spam: no source URL + info/log level.
          if (level < 2 && !url) return
          if (level < 2 && shouldDropExtConsoleMessage(msg)) return
          const truncated = msg.length > 400 ? msg.slice(0, 400) + ` …(${msg.length - 400} more)` : msg
          log.info('ext sw console', { partition, level, url, msg: truncated })
        },
      )
    }
  } catch (err) {
    log.warn('extensions: failed to wire SW console-message listener', { partition, err: String(err) })
  }
  configuredPartitions.add(partition)

  // Hand the partition over to electron-chrome-extensions BEFORE
  // loadEnabledExtensionsInto fires — the library installs its
  // session preload via registerPreloadScript, and chrome.* in
  // background-script and popup contexts only works for extensions
  // loaded AFTER that preload is registered.
  try {
    getOrCreateExtensions(ses, {
      createTab: async (details) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (!win || win.isDestroyed()) throw new Error('no live window for chrome.tabs.create')
        const url = typeof details.url === 'string' ? details.url : 'about:blank'
        const wc = await createTabForExtension(win, partition, url, details.active !== false)
        return [wc, win]
      },
      selectTab: (wc) => {
        // The library calls this for any setActiveTab in its store —
        // including the spurious one observeTab fires when we addTab
        // a background tab. Skip if we're orchestrating that addTab
        // round-trip ourselves; honour real chrome.tabs.update calls
        // from extensions otherwise.
        try {
          if (isLibrarySelectTabSuppressed()) return
          selectTabByWebContents(wc)
        } catch (err) {
          log.warn('extensions: ECE selectTab callback threw', { partition, err: String(err) })
        }
      },
      removeTab: (wc) => {
        try { destroyTabByWebContents(wc) }
        catch (err) { log.warn('extensions: ECE removeTab callback threw', { partition, err: String(err) }) }
      },
    })
    // Push live browser-action state to every workspace window backed by
    // this partition so the toolbar icons can update when extensions call
    // chrome.action.setIcon / setBadgeText / setTitle / setPopup. The
    // initial fire (inside subscribe) primes the renderer with manifest
    // defaults; subsequent fires arrive on each chrome.action.* mutation
    // or active-tab change.
    subscribeBrowserActionUpdates(ses, (state) => {
      broadcastBrowserActionState(partition, state)
    })
  } catch (err) {
    log.warn('extensions: ElectronChromeExtensions setup failed', { partition, err: String(err) })
  }

  // Load every user-installed, enabled extension into the partition so
  // content scripts / declarativeNetRequest rules / MV3 service workers
  // attach before the first page navigation in this partition. Fire and
  // forget — any individual extension failing shouldn't block partition
  // setup for the rest.
  loadEnabledExtensionsInto(ses).catch((err) => {
    log.warn('extensions: loadEnabledExtensionsInto failed', { partition, err: String(err) })
  })
}

/** Partitions configured so far — exported so the extension manager can
 *  broadcast install/uninstall events to every live session. */
export function getConfiguredPartitions(): string[] {
  return Array.from(configuredPartitions)
}

// ── Per-workspace window bounds persistence ──
const DEFAULT_WINDOW_WIDTH = 1400
const DEFAULT_WINDOW_HEIGHT = 900
const persistBoundsTimers = new Map<string, NodeJS.Timeout>()

function boundsVisibleOnAnyDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea
    const overlapX = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x)
    const overlapY = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y)
    if (overlapX > 100 && overlapY > 40) return true
  }
  return false
}

function captureWorkspaceBounds(workspaceId: string, win: BrowserWindow): void {
  if (!workspaceId || win.isDestroyed()) return
  const bounds = win.getNormalBounds()
  saveWorkspaceBounds(workspaceId, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  })
}

function scheduleCaptureWorkspaceBounds(workspaceId: string, win: BrowserWindow): void {
  if (!workspaceId) return
  const existing = persistBoundsTimers.get(workspaceId)
  if (existing) clearTimeout(existing)
  persistBoundsTimers.set(
    workspaceId,
    setTimeout(() => {
      persistBoundsTimers.delete(workspaceId)
      captureWorkspaceBounds(workspaceId, win)
    }, 500),
  )
}

function flushPendingBoundsCapture(workspaceId: string): void {
  const t = persistBoundsTimers.get(workspaceId)
  if (t) {
    clearTimeout(t)
    persistBoundsTimers.delete(workspaceId)
  }
}

export function closeWorkspaceWindow(workspaceId: string): void {
  const win = workspaceWindows.get(workspaceId)
  if (win && !win.isDestroyed()) {
    log.window('closeWorkspaceWindow', workspaceId, { stack: new Error().stack })
    win.close()
  }
  workspaceWindows.delete(workspaceId)
  workspaceProfiles.delete(workspaceId)
}

export function createWorkspaceWindow(profileId: string, workspaceId: string, workspaceName: string, targetTabId?: string): BrowserWindow {
  log.window('createWorkspaceWindow', { profileId, workspaceId, workspaceName, targetTabId })

  const existing = workspaceWindows.get(workspaceId)
  if (existing && !existing.isDestroyed()) {
    log.window('window already exists, focusing', workspaceId)
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    if (targetTabId) {
      existing.webContents.send('activate-tab', targetTabId)
    }
    return existing
  }

  // Preconfigure the partition session BEFORE the renderer creates webviews,
  // so configureSession's onBeforeSendHeaders hook and UA are applied from the
  // very first request. The renderer's setupSession() IPC call is fire-and-forget
  // and races the webview attach — this preconfiguration closes that race for
  // the common case where the partition matches the profile id.
  if (profileId) {
    try {
      setupPartitionSession(`persist:profile-${profileId}`)
    } catch (err) {
      log.warn('failed to preconfigure partition session', err)
    }
  }

  const isMac = process.platform === 'darwin'
  const savedBounds = loadWorkspaceBounds(workspaceId)
  const useSavedPosition =
    !!savedBounds &&
    boundsVisibleOnAnyDisplay({
      x: savedBounds.x,
      y: savedBounds.y,
      width: savedBounds.width,
      height: savedBounds.height,
    })

  const win = new BrowserWindow({
    width: savedBounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedBounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    ...(useSavedPosition ? { x: savedBounds!.x, y: savedBounds!.y } : {}),
    minWidth: 800,
    title: `${workspaceName} — ${APP_NAME}`,
    // Without this the window base paints white, which shows through as a
    // jarring frame around a fullscreen video (the tab WebContentsView is
    // transparent and may not cover the rect to the pixel). A dark base —
    // matching the title-bar overlay — blends with the video's letterbox
    // and the cinema-mode chrome instead.
    backgroundColor: '#161616',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 14 } }
      : { autoHideMenuBar: true, titleBarOverlay: { color: '#161616', symbolColor: '#d7d7d7', height: 47 } }),
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Tabs are hosted as WebContentsView children of the window's content
      // view (see src/main/tab-views.ts). The <webview> tag is disabled so
      // Chrome extensions loaded via session.loadExtension() actually attach
      // to page content — Electron's extension system does not inject into
      // <webview>, only into BrowserWindow / WebContentsView.
      webviewTag: false,
      // nativeWindowOpen used to be opt-in here; modern Electron makes it
      // the only mode and removed the WebPreferences flag entirely. Drop
      // the property to keep TypeScript happy with @types/electron 41+.
    },
  })
  if (!isMac) {
    win.setMenuBarVisibility(false)
  }
  if (savedBounds?.maximized) {
    win.maximize()
  }

  workspaceWindows.set(workspaceId, win)
  workspaceProfiles.set(workspaceId, profileId)
  lastKnownOpenWindows = [...workspaceWindows.keys()].map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
  // Seed last-active to the just-opened window so an external URL arriving
  // immediately after launch routes here even before the OS dispatches a
  // focus event.
  lastActiveWorkspaceId = workspaceId
  saveLastUsedWorkspace(profileId, workspaceId)
  win.on('focus', () => {
    lastActiveWorkspaceId = workspaceId
    // Resolve the profile at focus time — it may have been late-bound via
    // bindWebContentsToPartition after this window was created.
    saveLastUsedWorkspace(workspaceProfiles.get(workspaceId) ?? '', workspaceId)
  })
  installShortcutInterceptor(win.webContents, win)

  // Route the mouse side buttons (XButton1/XButton2 on Windows, matching
  // swipe gestures on macOS) to the renderer's existing back/forward shortcut
  // handler, which calls goBack()/goForward() on the active webview.
  win.on('app-command', (_event, command) => {
    if (command === 'browser-backward') {
      win.webContents.send('shortcut', 'back')
    } else if (command === 'browser-forward') {
      win.webContents.send('shortcut', 'forward')
    }
  })

  // Persist bounds on resize/move (debounced) and immediately on maximize
  // state changes so the window restores to its last size/position/maximized
  // state on the next launch or reopen.
  win.on('resize', () => scheduleCaptureWorkspaceBounds(workspaceId, win))
  win.on('move', () => scheduleCaptureWorkspaceBounds(workspaceId, win))
  win.on('maximize', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)
  })
  win.on('unmaximize', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)
  })

  win.on('close', () => {
    flushPendingBoundsCapture(workspaceId)
    captureWorkspaceBounds(workspaceId, win)

    // The 'close' event fires for both user-initiated closes (button, ⌘W,
    // app quit) and renderer-driven closes (renderer crash, win.close()
    // from the renderer). Capture the renderer state at the moment of
    // close so a Figma-style "window vanished mid-load" report has at
    // least something to triage from.
    const wc = win.webContents
    let crashed = false
    let activeUrl = ''
    try { crashed = wc.isCrashed() }
    catch (err) { log.warn('window close: isCrashed threw', { workspaceId, err: String(err) }) }
    try { activeUrl = wc.getURL() }
    catch (err) { log.warn('window close: getURL threw', { workspaceId, err: String(err) }) }
    log.info('window close', {
      workspaceId,
      windowId: win.id,
      crashed,
      activeUrl,
    })

    const allIds = [...workspaceWindows.keys()]
    const remainingIds = allIds.filter(id => id !== workspaceId)
    const toEntries = (ids: string[]) => ids.map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
    if (remainingIds.length === 0) {
      // Last window closing — preserve it so it restores on next launch
      lastKnownOpenWindows = toEntries(allIds)
    } else {
      // User intentionally closed this window — exclude it
      lastKnownOpenWindows = toEntries(remainingIds)
    }
    log.info('window close: updated lastKnownOpenWindows', { closingWorkspaceId: workspaceId, lastKnownOpenWindows })
  })

  win.on('closed', () => {
    log.info('window closed', { workspaceId, windowId: win.id })
    workspaceWindows.delete(workspaceId)
    workspaceProfiles.delete(workspaceId)
  })

  // Allow renderer-created detached dialog windows and hide their native header.
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Accept both `'about:blank'` and the empty string. `window.open('')`
    // and `window.open(undefined)` can surface here as either, depending on
    // the Chromium / Electron version, and treating only the literal
    // `'about:blank'` as openable made dialogs intermittently fail to
    // appear — the renderer-side React state would flip to "open" but the
    // native popup never spawned.
    if (url === 'about:blank' || url === '') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          frame: false,
          autoHideMenuBar: true,
          fullscreenable: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        },
      }
    }
    log.warn('setWindowOpenHandler: denying non-blank popup', { url })
    return { action: 'deny' }
  })

  // Diagnostic: log when the workspace window's MAIN renderer goes down.
  // Without this, a renderer crash on the main webContents looks identical
  // to a normal window close — we'd see only the BrowserWindow's `close`
  // event with no clue why the user lost their window.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('main webContents render-process-gone', {
      windowId: win.id,
      workspaceId,
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
  win.webContents.on('unresponsive', () => {
    log.warn('main webContents unresponsive', { windowId: win.id, workspaceId })
  })
  win.webContents.on('responsive', () => {
    log.info('main webContents responsive again', { windowId: win.id, workspaceId })
  })
  // The page-level 'close' on the BrowserWindow's MAIN webContents is what
  // fires when the workspace renderer or some script tied to it requests
  // the window to be closed (e.g. an Electron quirk where window.close()
  // from a child WebContentsView bubbles up). Surfacing it explicitly tells
  // us whether the BrowserWindow's close is renderer-driven or coming from
  // somewhere else in the main process.
  // WebContents emits 'close' at runtime (this log line fires regularly)
  // but electron.d.ts doesn't declare the event — go through the
  // EventEmitter base signature.
  ;(win.webContents as NodeJS.EventEmitter).on('close', () => {
    log.info('main wc close', { windowId: win.id, workspaceId })
  })
  win.webContents.on('destroyed', () => {
    log.info('main wc destroyed', { windowId: win.id, workspaceId })
  })
  win.webContents.on('will-prevent-unload', () => {
    log.info('main will-prevent-unload', { windowId: win.id, workspaceId })
  })

  // Track detached popups so the drag IPC handlers can identify them when the
  // renderer requests a move. The popup is created synchronously after the
  // setWindowOpenHandler callback returns `allow`, and this event fires.
  win.webContents.on('did-create-window', (childWindow) => {
    registerDetachedPopup(childWindow)
    // The popup was created with show:false. Make it physically invisible via
    // OS compositor opacity, then "show" it so the renderer can paint into it.
    // The window stays at opacity 0 until the renderer signals that React has
    // finished rendering content (detached-window:show IPC).
    childWindow.setOpacity(0)
    childWindow.showInactive()
  })

  // Each tab is a WebContentsView child of this window (see tab-views.ts).
  // Register callbacks so the manager can install the shortcut interceptor
  // on every new tab's webContents, and tear down tabs on window close.
  registerWorkspaceWindowForTabs(win, installShortcutInterceptor)

  // Drain any URLs the OS handed us before any window existed (cold start
  // via a default-browser link click). Has to run AFTER the window is in
  // workspaceWindows so the helper finds it as a target.
  flushPendingUrlsTo(win)

  const tabSuffix = targetTabId ? `&tabId=${encodeURIComponent(targetTabId)}` : ''
  const params = `?profileId=${profileId}&workspaceId=${workspaceId}${tabSuffix}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + params)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: `profileId=${profileId}&workspaceId=${workspaceId}${tabSuffix}`,
    })
  }

  return win
}

export function rebuildMenu(): void {
  buildMenu()
}

/** Menu click handlers receive `BaseWindow | undefined` per Electron 41+
 *  types, but at runtime the focused window in our app is always a
 *  BrowserWindow with a webContents. Narrowing helper used by every menu
 *  item that fires a `shortcut` IPC. */
function sendShortcutToWindow(win: Electron.BaseWindow | undefined, action: string): void {
  const wc = (win as Electron.BrowserWindow | undefined)?.webContents
  if (wc && !wc.isDestroyed()) wc.send('shortcut', action)
}

function toggleUiDevTools(win: Electron.BaseWindow | undefined): void {
  const target = (win as Electron.BrowserWindow | undefined) ?? BrowserWindow.getFocusedWindow()
  const wc = target?.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  } catch (err) {
    log.warn('toggle UI DevTools failed', { err: String(err) })
  }
}

function buildMenu(): void {
  const settings = loadSettings()
  const merged = { ...DEFAULT_KEYBINDINGS, ...settings.keybindings }
  // Electron menu items take a single accelerator string; with up-to-two
  // bindings per action we surface the FIRST one in the menu UI. The
  // second binding still fires via the before-input-event interceptor —
  // the menu just doesn't have a second column to advertise it.
  const kb: Record<string, string | undefined> = {}
  for (const key of Object.keys(merged)) {
    const list = merged[key]
    kb[key] = Array.isArray(list) && list.length > 0 ? list[0] : undefined
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: (_item, win) => sendShortcutToWindow(win, 'open-settings-about'),
        },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: kb['settings'],
          click: (_item, win) => sendShortcutToWindow(win, 'settings'),
        },
        { type: 'separator' },
        { label: `Hide ${APP_NAME}`, role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Exit ${APP_NAME}`, role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: kb['new-tab'],
          click: (_item, win) => sendShortcutToWindow(win, 'new-tab'),
        },
        {
          label: 'Close Tab',
          accelerator: kb['close-tab'],
          click: (_item, win) => sendShortcutToWindow(win, 'close-tab'),
        },
        {
          label: 'Close Window',
          accelerator: kb['close-window'],
          click: (_item, win) => {
            if (win && !win.isDestroyed()) {
              log.info('menu Close Window clicked', { windowId: (win as Electron.BrowserWindow).id })
              win.close()
            }
          },
        },
        { type: 'separator' },
        {
          label: 'New Workspace',
          accelerator: kb['new-workspace'],
          click: (_item, win) => sendShortcutToWindow(win, 'new-workspace'),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        // Always target the workspace chrome renderer. Electron's role-based
        // toggle follows the focused WebContents, which is often the active
        // page's WebContentsView.
        { label: 'Toggle UI Developer Tools', click: (_item, win) => toggleUiDevTools(win) },
        // The active tab is rendered by a sibling WebContentsView, which
        // toggleDevTools never reaches. Route through the renderer's
        // shortcut handler so the active-tab id is resolved on its side.
        {
          label: 'Toggle Page Developer Tools',
          accelerator: kb['page-devtools'],
          click: (_item, win) => sendShortcutToWindow(win, 'page-devtools'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Focus Address Bar',
          accelerator: kb['focus-url'],
          click: (_item, win) => sendShortcutToWindow(win, 'focus-url'),
        },
        {
          label: 'Search Everything',
          accelerator: kb['search'],
          click: (_item, win) => sendShortcutToWindow(win, 'search'),
        },
        {
          label: 'Command Palette',
          accelerator: kb['command-palette'],
          click: (_item, win) => sendShortcutToWindow(win, 'command-palette'),
        },
        {
          label: 'Toggle Sidebar',
          accelerator: kb['toggle-sidebar'],
          click: (_item, win) => sendShortcutToWindow(win, 'toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: kb['back'],
          click: (_item, win) => sendShortcutToWindow(win, 'back'),
        },
        {
          label: 'Forward',
          accelerator: kb['forward'],
          click: (_item, win) => sendShortcutToWindow(win, 'forward'),
        },
        {
          label: 'Reload Page',
          accelerator: kb['reload'],
          click: (_item, win) => sendShortcutToWindow(win, 'reload'),
        },
        { type: 'separator' },
        {
          label: 'Find in Page',
          accelerator: kb['find-in-page'],
          click: (_item, win) => sendShortcutToWindow(win, 'find-in-page'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // On Windows/Linux, hide the menu bar on all windows (shortcuts still work via the application menu)
  if (process.platform !== 'darwin') {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setAutoHideMenuBar(true)
      win.setMenuBarVisibility(false)
    }
  }
}

function openInitialWindows(): void {
  const state = loadState() as any
  log.info('openInitialWindows', { hasState: !!state, profileCount: state?.profiles?.length })
  if (!state || !state.profiles || state.profiles.length === 0) return

  const savedWindows = loadOpenWindows()
  log.info('openInitialWindows', { savedWindows })

  if (savedWindows.length > 0) {
    // Restore windows that were open last time, across all profiles
    for (const entry of savedWindows) {
      const profile = state.profiles.find((p: any) => p.id === entry.profileId)
      if (!profile) continue
      const ws = profile.workspaces.find((w: any) => w.id === entry.workspaceId)
      if (ws) {
        createWorkspaceWindow(profile.id, ws.id, ws.name)
      }
    }
  } else {
    // First launch or no saved state — open all workspaces from active profile
    const activeProfile = state.profiles.find((p: any) => p.id === state.activeProfileId) || state.profiles[0]
    for (const ws of activeProfile.workspaces) {
      createWorkspaceWindow(activeProfile.id, ws.id, ws.name)
    }
  }
}

app.whenReady().then(async () => {
  // ── Set dock icon on macOS ──
  if (process.platform === 'darwin' && app.dock) {
    try {
      const dockIcon = nativeImage.createFromPath(iconPng)
      log.info('dock icon size', dockIcon.getSize())
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon)
      } else {
        log.warn('dock icon is empty, check icon.png path:', iconPng)
      }
    } catch (err) {
      log.error('failed to set dock icon', err)
    }
  }

  // ── About panel ──
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Newbro Browser',
    version: '',
  })

  // 'persist:default' is the conventional partition string for the
  // default session — used in log messages and any partition-keyed map
  // lookups (e.g. waitingAuthPolls). The default session is shared with
  // the main renderer, not a workspace tab, so no SW IPC actually
  // routes through this branch in practice; passing the string keeps
  // configureSession's body uniform.
  configureSession(session.defaultSession, 'persist:default')
  applyProxySettingsToAllSessions(loadSettings())

  // DNS-over-HTTPS (Cloudflare + Google). Mode is user-configurable
  // via Settings → DNS. 'automatic' default preserves OS resolver
  // (corp VPN DNS, hosts file) and uses DoH as fallback. 'secure'
  // bypasses OS resolver entirely — maximum privacy but breaks corp
  // intranet hosts. 'off' leaves DNS untouched.
  //
  // Must run after app.ready; calling earlier throws. Changes via
  // Settings require app restart to take effect (Chromium-level
  // configuration applies at startup).
  try {
    const dohMode = loadSettings().dohMode
    if (dohMode === 'off') {
      log.info('dns: DNS-over-HTTPS disabled (settings)', { mode: 'off' })
    } else {
      app.configureHostResolver({
        secureDnsMode: dohMode,
        secureDnsServers: [
          'https://cloudflare-dns.com/dns-query',
          'https://dns.google/dns-query',
        ],
      })
      log.info('dns: DNS-over-HTTPS enabled', { mode: dohMode })
    }
  } catch (err) {
    log.warn('dns: configureHostResolver failed', String(err))
  }

  // Patch electron-chrome-extensions's preload file in place to support
  // MV3 chrome.action.setIcon({imageData: ...}). The library's stock
  // preload strips imageData on MV3 with a `console.warn`, and Browsec
  // (and any other extension that renders dynamic icons via canvas /
  // OffscreenCanvas) loses every runtime icon update through that path.
  // The main-process side of the library already accepts imageData as a
  // base64 data URL — only the preload's MV3 guard blocks it. We replace
  // the strip with a SW-aware imageData→base64 path. Idempotent: a
  // marker comment prevents double-patching when npm install hasn't
  // wiped node_modules.
  patchLibraryPreloadForMV3SetIcon()

  // Register the `crx://` protocol on the renderer's session so the
  // toolbar can fetch dynamic extension icons (chrome.action.setIcon)
  // by URL. The library's handler resolves cross-partition via the
  // ?partition= query param, so the renderer can ask for any profile's
  // icon by passing its partition string.
  try {
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  } catch (err) {
    log.warn('extensions: handleCRXProtocol(default) failed', String(err))
  }

  // Start the loopback RPC server BEFORE rehydrating extensions. The
  // shim injection in rehydrateExtensionsOnStartup substitutes the
  // server's port + secret into the SW shim source on disk; if we
  // injected before the server was up, the patched files would carry
  // a stale port=0 placeholder and every auth-poll would 404.
  await startSwRpcServer({
    authPoll: async (extId, timeoutMs) => {
      // Per-extension routing: each extId that polls gets the next
      // challenge not yet delivered to it. Challenges are fanned out to
      // every concurrently-polling extension; resolveAuthChallenge then
      // settles on the first /auth-respond. Empty extId falls back to a
      // single-receiver fan, which keeps the old single-VPN flow working
      // even if the SW shim is somehow built without an extId in the URL.
      const resp = await waitForAuthChallenge(extId || '*', timeoutMs)
      try { return await resp.json() }
      catch (err) {
        log.warn('rpc/authPoll: response.json threw', { err: String(err) })
        return {}
      }
    },
    authRespond: (challengeId, response) => {
      const r = (response ?? {}) as { authCredentials?: { username?: string; password?: string }; cancel?: boolean }
      resolveAuthChallenge(challengeId, r)
    },
    activeTabInfo: (_partition) => {
      // Active tab = focused workspace window's active tab. The
      // partition tag is informational only; we don't have a
      // multi-window-per-partition model that requires it.
      const focused = BrowserWindow.getFocusedWindow()
      const win = focused && !focused.isDestroyed()
        ? focused
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return null
      return getActiveTabInfoForWindow(win.id)
    },
    partitionFromHeader: (_req) => {
      // SW shim doesn't send partition; return a sentinel so the
      // server's "no partition" rejection path doesn't fire. All the
      // routes are partition-agnostic in the global-queue design.
      return '*'
    },
    coldStartCheck: (extId) => {
      // First call per extId per main-process lifetime returns true,
      // every subsequent call returns false. Backs the SW shim's
      // chrome.runtime.onStartup implementation: real Chrome fires
      // onStartup once at cold browser start, not on every SW
      // wake-up. Browsec's "restore proxy state if previously on"
      // logic hangs off onStartup, so missing this means the
      // extension stays idle until the user clicks Turn on every
      // single launch.
      if (extId && coldStartFiredFor.has(extId)) return false
      if (extId) coldStartFiredFor.add(extId)
      log.info('extensions: cold-start check', { extId, isCold: true })
      return true
    },
    storagePoll: async (extId, timeoutMs) => {
      return await waitForStorageChange(extId, timeoutMs)
    },
    cookiesGet: async (_partition, details) => {
      const ses = pickCookiesSession()
      if (!ses) return null
      const cookies = await ses.cookies.get(details ?? {})
      return cookies[0] ? toCookieDetails(cookies[0]) : null
    },
    cookiesGetAll: async (_partition, details) => {
      const ses = pickCookiesSession()
      if (!ses) return []
      const cookies = await ses.cookies.get((details ?? {}) as Electron.CookiesGetFilter)
      return cookies.map(toCookieDetails)
    },
    cookiesSet: async (_partition, details) => {
      const ses = pickCookiesSession()
      if (!ses) return null
      try {
        await ses.cookies.set(details as unknown as Electron.CookiesSetDetails)
        const back = await ses.cookies.get({ url: (details as { url?: string }).url, name: (details as { name?: string }).name })
        return back[0] ? toCookieDetails(back[0]) : null
      } catch (err) {
        log.warn('rpc/cookies.set threw', { err: String(err) })
        return null
      }
    },
    cookiesRemove: async (_partition, details) => {
      const ses = pickCookiesSession()
      if (!ses) return null
      try {
        await ses.cookies.remove(String(details.url ?? ''), String(details.name ?? ''))
        return { url: details.url, name: details.name, storeId: '0' }
      } catch (err) {
        log.warn('rpc/cookies.remove threw', { err: String(err) })
        return null
      }
    },
    runtimeMsgSend: async (extId, payload) => {
      const msgId = enqueueRuntimeMessage(extId, payload)
      log.info('rpc/runtime-msg-send queued', { extId, msgId })
      return new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => {
          if (pendingRuntimeMsgRequests.delete(msgId)) {
            log.warn('rpc/runtime-msg-send timed out', { extId, msgId })
            resolve(null)
          }
        }, 10000)
        pendingRuntimeMsgRequests.set(msgId, (response) => {
          clearTimeout(timer)
          resolve(response)
        })
      })
    },
    runtimeMsgPoll: async (extId, timeoutMs) => {
      return await waitForRuntimeMessage(extId, timeoutMs)
    },
    runtimeMsgRespond: (msgId, response) => {
      const cb = pendingRuntimeMsgRequests.get(msgId)
      if (!cb) return
      pendingRuntimeMsgRequests.delete(msgId)
      cb(response)
    },
    portOpen: (extId, name) => openPort(extId, name),
    portContentSend: (portId, message) => portContentSend(portId, message),
    portContentPoll: (portId, timeoutMs) => portContentPoll(portId, timeoutMs),
    portSwSend: (portId, message) => portSwSend(portId, message),
    portSwPoll: (extId, timeoutMs) => portSwPoll(extId, timeoutMs),
    portDisconnect: (portId, side) => portDisconnect(portId, side),
    userScriptsExecute: async (extId, injection) => {
      // Resolve target tab(s) → list of webContents to inject into.
      const target = (injection.target ?? {}) as {
        tabId?: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean
      }
      const tabId = typeof target.tabId === 'number' ? target.tabId : -1
      if (tabId < 0) {
        log.warn('rpc/userScripts.execute: no tabId', { extId, target })
        return []
      }
      const wc = getWebContentsByChromeTabId(tabId)
      if (!wc) {
        log.warn('rpc/userScripts.execute: tab not found', { extId, tabId })
        return []
      }
      // Resolve injection.js → concatenated code string. Each entry is
      // either {code: '...'} or {file: 'rel/path/inside/ext.js'}; file
      // paths are read off the extension directory (the same place
      // chrome.userScripts.register's file refs come from).
      const jsList = Array.isArray(injection.js) ? injection.js as Array<Record<string, unknown>> : []
      const entry = getExtensionEntry(extId)
      const pieces: string[] = []
      for (const j of jsList) {
        if (typeof j.code === 'string') {
          pieces.push(j.code as string)
        } else if (typeof j.file === 'string' && entry?.path) {
          const rel = (j.file as string).replace(/^\/+/, '')
          if (rel.includes('..')) continue
          const abs = join(entry.path, rel)
          try {
            if (existsSync(abs)) pieces.push(readFileSync(abs, 'utf8'))
          } catch (err) {
            log.warn('rpc/userScripts.execute: file read threw', { extId, file: rel, err: String(err) })
          }
        }
      }
      const code = pieces.join('\n;\n')
      if (!code) {
        log.info('rpc/userScripts.execute: empty code', { extId, tabId })
        return [{ frameId: 0, documentId: '', result: undefined }]
      }
      const world = injection.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT'
      log.info('rpc/userScripts.execute', { extId, tabId, world, jsLen: code.length, jsHead: code.slice(0, 200) })
      try {
        if (world === 'MAIN') {
          // executeJavaScript runs the script in the page's main world.
          // It's embedder-level — bypasses page CSP entirely. This is
          // the path real Chrome's chrome.userScripts.execute takes
          // when world: 'MAIN' is requested, and the reason userscript
          // managers prefer it over inline <script> injection on
          // strict-CSP sites.
          const result = await wc.executeJavaScript(code, false)
          return [{ frameId: 0, documentId: '', result }]
        }
        // world === 'USER_SCRIPT': run in a dedicated isolated world so
        // page globals stay invisible to the userscript and vice versa.
        // World id is derived per-extension so subsequent execute calls
        // from the same extension share state (matches Chrome's per-
        // extension USER_SCRIPT world isolation).
        const worldId = 1000 + (Math.abs(hashStringForWorld(extId)) % 1000)
        const maybe = (wc as unknown as {
          executeJavaScriptInIsolatedWorld?: (worldId: number, scripts: { code: string }[]) => Promise<unknown> | void
        }).executeJavaScriptInIsolatedWorld?.(worldId, [{ code }])
        let result: unknown = undefined
        if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
          result = await (maybe as Promise<unknown>)
        }
        return [{ frameId: 0, documentId: '', result }]
      } catch (err) {
        log.warn('rpc/userScripts.execute threw', { extId, tabId, world, err: String(err) })
        return [{ frameId: 0, documentId: '', error: String(err) }]
      }
    },
  }).catch((err) => {
    log.error('sw-rpc-server: failed to start', { err: String(err) })
  })

  // Rehydrate installed extensions before any window opens. Each entry is
  // loaded into sessions as they get configured by setupPartitionSession.
  rehydrateExtensionsOnStartup().catch((err) => {
    log.warn('extensions: rehydrate failed', String(err))
  })

  // Wire CDP auth-challenge router BEFORE startSwCdpInspector so any
  // SW that comes up immediately has its Fetch.authRequired events
  // handled. Routes the challenge into the same queue the SW shim's
  // auth-poll consumes — Browsec's chrome.webRequest.onAuthRequired
  // listener gets the same payload it would in real Chrome, supplies
  // credentials, and we send those back via Fetch.continueWithAuth.
  // This is what unblocks SW-initiated proxy auth (Browsec's
  // webstat.me ping etc.) on Electron 41, which doesn't surface
  // webRequest.onAuthRequired or session.on('login') for SW fetches.
  setSwCdpAuthHandler((details, respond) => {
    const challengeId = `cdp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // CDP fetches don't carry a partition affinity, but the SW
    // necessarily lives in some configured partition. Use the only
    // configured partition when there's exactly one (single-profile
    // case) and a generic '*' otherwise — informational only, the
    // queue is global and challengeId routes the response.
    const partition = configuredPartitions.size === 1
      ? Array.from(configuredPartitions)[0]
      : '*'
    const detailsLite = {
      url: details.url,
      method: 'GET',
      isProxy: details.isProxy,
      scheme: details.scheme,
      realm: details.realm,
      challenger: details.challenger,
    }
    pendingAuthChallenges.set(challengeId, {
      partition,
      details: detailsLite,
      callback: (resp) => {
        let cdpResp: SwCdpAuthResponse
        if (resp && typeof resp.cancel === 'boolean' && resp.cancel) {
          cdpResp = { cancel: true }
        } else if (resp && typeof resp.username === 'string') {
          cdpResp = { username: resp.username, password: resp.password ?? '' }
        } else {
          cdpResp = { cancel: true }
        }
        respond(cdpResp)
      },
      timer: setTimeout(() => {
        if (pendingAuthChallenges.delete(challengeId)) {
          log.warn('extensions: CDP auth challenge timed out', { partition, url: details.url })
          respond({ cancel: true })
        }
      }, 15000),
    })
    enqueueAuthChallenge({ id: challengeId, partition, details: detailsLite, deliveredTo: new Set() })
    log.info('extensions: auth challenge queued', {
      partition,
      challengeId,
      url: details.url,
      isProxy: details.isProxy,
      source: 'cdp.Fetch.authRequired',
      swTarget: details.swTargetId,
    })
  })

  // Self-attach to extension SWs via CDP and pipe their network events
  // into our log. Reveals the actual `net::ERR_*` behind any "Failed
  // to fetch" the SW reports — without needing to open external Chrome
  // and connect to chrome://inspect. Also handles SW-initiated proxy
  // auth via the handler registered just above.
  startSwCdpInspector()

  buildMenu()
  registerIpcHandlers()
  registerHttpAuthIpc()
  installTabPreloadListeners()
  setupAutoUpdater()
  // Pull synced data (tabs/workspaces, settings, …) before the first windows
  // open, so restored windows reflect the latest cloud state. Best-effort —
  // a sync failure must never block startup.
  try {
    await initCloudSync()
  } catch (err) {
    log.warn('cloud-sync: init failed', String(err))
  }
  openInitialWindows()

  if (BrowserWindow.getAllWindows().length === 0) {
    createWorkspaceWindow('', '', 'Default')
  }
})

app.on('before-quit', () => {
  // Use lastKnownOpenWindows — by this point windows may already be destroyed (close-last-window path)
  let entries: OpenWindowEntry[]
  if (workspaceWindows.size > 0) {
    entries = [...workspaceWindows.keys()].map(id => ({ profileId: workspaceProfiles.get(id)!, workspaceId: id }))
  } else {
    entries = lastKnownOpenWindows
  }
  log.info('before-quit: saving open windows', { entries })
  saveOpenWindows(entries)
  // Flush any debounced sync pushes synchronously — async work won't finish
  // once the app starts tearing down.
  try { flushPushSync() } catch (err) { log.warn('cloud-sync: flush failed', String(err)) }
})

app.on('window-all-closed', () => {
  app.quit()
})
