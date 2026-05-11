// Local HTTP server bound to 127.0.0.1 that serves the SW shim's
// round-trip RPCs (auth-poll, auth-respond, active-tab-info).
//
// Why this exists despite our existing webRequest IPC channel:
// Chromium's SW fetch refuses three transports we tried before this:
//   1. Custom schemes (newbro-ipc://) → ERR_UNKNOWN_URL_SCHEME
//   2. webRequest cancel → no response body, only fire-and-forget
//   3. webRequest redirect to data: URL → ERR_UNSAFE_REDIRECT (Chromium
//      explicitly rejects redirecting fetch to data:)
//
// A real HTTP server avoids all three problems: 127.0.0.1 is in
// Chromium's "potentially trustworthy" allowlist for SW contexts, the
// `*` in the patched extension CSP allows the connection, and a real
// 200 response carries the body without any redirect dance.
//
// Security: bound to 127.0.0.1 (loopback) so external machines
// can't reach it. Each request must include the per-process secret
// in the X-Newbro-Token header — without that, the server returns
// 403 immediately. The secret is generated once and persisted to
// userData/sw-rpc-config.json; only main and the SW shim (via
// injection at install time) ever see it.
//
// Why port + secret are persistent (not rolled per launch):
// Chromium aggressively caches MV3 service worker source bytes
// between launches. If we rolled the port each launch, the cached
// SW would wake up with a STALE port baked in (the previous launch's
// port that no longer listens), every auth-poll would hit
// ERR_CONNECTION_REFUSED, and the proxy auth flow wedged until
// Chromium's update check eventually noticed the bytes had changed
// and spawned a fresh SW. Symptom: VPN extensions like Browsec
// require a "Fix connection" click after every app restart before
// they actually toggle. By keeping port + secret stable, the
// rewritten on-disk SW source is byte-identical to what Chromium
// already has cached → no update churn → first activation works.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'

export interface SwRpcServerInfo {
  port: number
  secret: string
}

export interface SwRpcRoutes {
  /** Resolves with the next webRequest.onAuthRequired challenge that
   *  hasn't yet been delivered to this extension, or {} if the timeout
   *  elapsed. extId identifies the calling SW; the same challenge is
   *  fanned out to every extension whose SW is concurrently long-polling
   *  /auth-poll, and the first one to /auth-respond wins. */
  authPoll: (extId: string, timeoutMs: number) => Promise<unknown>
  /** Forwards the SW's BlockingResponse for an in-flight auth challenge. */
  authRespond: (challengeId: string, response: unknown) => void
  /** Returns the active tab's tabs.Tab-shaped info for a partition. */
  activeTabInfo: (partition: string) => unknown
  /** Map a request → partition. Provided by the caller because we
   *  intentionally don't ship request-level auth beyond the secret;
   *  the partition is identified by a header set in the SW shim. */
  partitionFromHeader: (req: IncomingMessage) => string | null
  /** Returns true if this is the first time the SW has asked about
   *  cold start for this extension since the main process started.
   *  Backs chrome.runtime.onStartup in the SW shim — Browsec gates
   *  proxy-state restoration on it, so without a one-shot true the
   *  extension never resumes on app launch. Subsequent calls return
   *  false (Chromium can restart a SW many times within a single
   *  app session; only cold app start counts as "startup"). */
  coldStartCheck: (extId: string) => boolean
  /** Long-polls for chrome.storage.onChanged events that originated in
   *  non-SW contexts (popup, options page, content script). In Electron
   *  41 chrome.storage.onChanged DOES fire in the writing context but
   *  doesn't propagate cross-context to chrome-extension service
   *  workers, so we bridge it manually: the popup preload posts each
   *  onChanged payload to main via newbro-ipc, main queues it per
   *  extId, and the SW shim consumes it via this poll → re-fires
   *  chrome.storage.onChanged in the SW realm. Resolves with the next
   *  queued change or {} on timeout. */
  storagePoll: (extId: string, timeoutMs: number) => Promise<unknown>
  /** chrome.cookies.get/getAll/set/remove forwarders for SW context.
   *  The electron-chrome-extensions library implements these for frame
   *  contexts via its preload, but the preload doesn't fire in SW
   *  context (Electron 41 quirk), so extensions calling chrome.cookies
   *  from a service worker would otherwise hit our auto-stub and
   *  silently no-op. partition is the caller's partition string — for
   *  now we infer it from the focused workspace window since the SW
   *  shim source is shared across partitions. */
  cookiesGet: (partition: string, details: { url?: string; name?: string }) => Promise<unknown>
  cookiesGetAll: (partition: string, details: Record<string, unknown>) => Promise<unknown[]>
  cookiesSet: (partition: string, details: Record<string, unknown>) => Promise<unknown>
  cookiesRemove: (partition: string, details: { url?: string; name?: string }) => Promise<unknown>
  /** Round-trip chrome.runtime.sendMessage bridge between non-binding
   *  contexts (e.g. user scripts injected via chrome.userScripts.register
   *  into a fresh isolated world that doesn't get Chromium's chrome.*
   *  binding) and the extension's SW. */
  runtimeMsgSend: (extId: string, payload: unknown) => Promise<unknown>
  /** SW long-polls for incoming runtime messages destined for its
   *  chrome.runtime.onMessage listeners. */
  runtimeMsgPoll: (extId: string, timeoutMs: number) => Promise<unknown>
  /** SW POSTs the listener's response back. */
  runtimeMsgRespond: (msgId: string, response: unknown) => void
  /** chrome.runtime.connect bridge — port-based bidirectional messaging.
   *  Same motivation as runtimeMsg* above (Tampermonkey content.js
   *  reaches for chrome.runtime.connect to talk to its SW, and our
   *  userscript-world setup stub had a no-op port). Ports are identified
   *  by a server-generated portId that flows across every route. */
  portOpen: (extId: string, name: string) => string
  portContentSend: (portId: string, message: unknown) => void
  portContentPoll: (portId: string, timeoutMs: number) => Promise<unknown>
  portSwSend: (portId: string, message: unknown) => void
  portSwPoll: (extId: string, timeoutMs: number) => Promise<unknown>
  portDisconnect: (portId: string, side: 'content' | 'sw') => void
  /** chrome.userScripts.execute({target, js, world, ...}) backend.
   *  Bypasses host-page CSP by going through Electron's embedder-level
   *  webContents.executeJavaScript (for world: 'MAIN') or
   *  executeJavaScriptInIsolatedWorld (for world: 'USER_SCRIPT'). Real
   *  Chrome's chrome.userScripts.execute is the privileged path TM
   *  switches to when "Allow user scripts" is enabled — it's the only
   *  way to inject scripts into pages with strict CSP. */
  userScriptsExecute: (
    extId: string,
    injection: Record<string, unknown>,
  ) => Promise<Array<{ frameId?: number; documentId?: string; result?: unknown; error?: string }>>
}

let started: SwRpcServerInfo | null = null
let server: Server | null = null

interface PersistedConfig {
  port?: number
  secret?: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'sw-rpc-config.json')
}

function loadPersistedConfig(): PersistedConfig {
  const path = configPath()
  if (!existsSync(path)) return {}
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedConfig
    return {
      port: typeof parsed.port === 'number' && parsed.port > 0 && parsed.port < 65536 ? parsed.port : undefined,
      secret: typeof parsed.secret === 'string' && parsed.secret.length >= 32 ? parsed.secret : undefined,
    }
  } catch (err) {
    log.warn('sw-rpc-server: persisted config read failed', { err: String(err) })
    return {}
  }
}

function savePersistedConfig(cfg: PersistedConfig): void {
  try {
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
  } catch (err) {
    log.warn('sw-rpc-server: persisted config write failed', { err: String(err) })
  }
}

/** Bind once with the given preferred port (0 → OS-assigned). Resolves with
 *  the bound port, or rejects on hard error. EADDRINUSE on a non-zero
 *  preferred port is treated as a soft failure — the caller retries with 0. */
function listenOnce(s: Server, preferredPort: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      s.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      s.removeListener('error', onError)
      const addr = s.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('sw-rpc-server: address() returned ' + JSON.stringify(addr)))
        return
      }
      resolve(addr.port)
    }
    s.once('error', onError)
    s.once('listening', onListening)
    s.listen(preferredPort, '127.0.0.1')
  })
}

/** Idempotently start the loopback RPC server.
 *
 *  Reuses the previous launch's port + secret from
 *  userData/sw-rpc-config.json so the on-disk SW shim source stays
 *  byte-identical across launches (see the file header for why this
 *  matters for Chromium's SW byte-cache). Falls back to a fresh
 *  random port if the saved port is in use, and persists the chosen
 *  values back to disk. */
export async function startSwRpcServer(routes: SwRpcRoutes): Promise<SwRpcServerInfo> {
  if (started) return started
  const persisted = loadPersistedConfig()
  const secret = persisted.secret ?? randomBytes(24).toString('hex')
  const preferredPort = persisted.port ?? 0
  const s = createServer((req, res) => handleRequest(req, res, secret, routes))
  let port: number
  try {
    port = await listenOnce(s, preferredPort)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (preferredPort !== 0 && code === 'EADDRINUSE') {
      log.warn('sw-rpc-server: persisted port in use, falling back to OS-assigned', {
        preferredPort,
      })
      port = await listenOnce(s, 0)
    } else {
      log.warn('sw-rpc-server: listen error', { err: String(err), code })
      throw err
    }
  }
  started = { port, secret }
  server = s
  if (persisted.port !== port || persisted.secret !== secret) {
    savePersistedConfig({ port, secret })
  }
  log.info('sw-rpc-server: listening', {
    port,
    persisted: { port: persisted.port ?? null, hadSecret: !!persisted.secret },
  })
  return started
}

export function getSwRpcServerInfo(): SwRpcServerInfo | null {
  return started
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
  routes: SwRpcRoutes,
): Promise<void> {
  const respondJson = (status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    // SW fetches cross-origin (from chrome-extension://...) — the
    // browser enforces CORS on the response. Allow * because the
    // secret token is the actual access control.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Newbro-Token, X-Newbro-Partition')
    res.setHeader('Access-Control-Max-Age', '86400')
    try { res.end(JSON.stringify(body)) }
    catch (err) { log.warn('sw-rpc-server: res.end threw', { err: String(err) }) }
  }

  // CORS preflight — no auth check; preflight is identity-less.
  if (req.method === 'OPTIONS') {
    respondJson(204, '')
    return
  }

  // Per-process secret check. Hides the server from anything that
  // didn't get the token via SW shim injection.
  const token = req.headers['x-newbro-token']
  if (typeof token !== 'string' || token !== secret) {
    log.warn('sw-rpc-server: rejected (bad token)', { url: req.url })
    respondJson(403, { error: 'forbidden' })
    return
  }

  const url = req.url ?? ''
  const path = url.split('?')[0] ?? ''
  const partition = routes.partitionFromHeader(req)
  if (!partition) {
    respondJson(400, { error: 'no-partition' })
    return
  }

  if (path === '/auth-poll' && req.method === 'GET') {
    const extId = new URL(url, 'http://x').searchParams.get('extId') ?? ''
    try {
      const payload = await routes.authPoll(extId, 25000)
      respondJson(200, payload ?? {})
    } catch (err) {
      log.warn('sw-rpc-server: auth-poll threw', { partition, extId, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/auth-respond' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = JSON.parse(body) as { challengeId?: string; response?: unknown }
      if (parsed && typeof parsed.challengeId === 'string') {
        routes.authRespond(parsed.challengeId, parsed.response)
      }
      respondJson(200, { ok: true })
    } catch (err) {
      log.warn('sw-rpc-server: auth-respond parse failed', { partition, err: String(err) })
      respondJson(400, { error: 'parse' })
    }
    return
  }

  if (path === '/active-tab-info' && req.method === 'GET') {
    const tab = routes.activeTabInfo(partition)
    respondJson(200, { tab })
    return
  }

  if (path === '/cold-start-check' && req.method === 'GET') {
    const extId = new URL(url, 'http://x').searchParams.get('extId') ?? ''
    const isCold = routes.coldStartCheck(extId)
    respondJson(200, { isCold })
    return
  }

  if (path === '/storage-poll' && req.method === 'GET') {
    const extId = new URL(url, 'http://x').searchParams.get('extId') ?? ''
    try {
      const payload = await routes.storagePoll(extId, 25000)
      respondJson(200, payload ?? {})
    } catch (err) {
      log.warn('sw-rpc-server: storage-poll threw', { extId, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-msg-send' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { extId?: string; payload?: unknown } : {}
      const extId = typeof parsed.extId === 'string' ? parsed.extId : ''
      if (!extId) { respondJson(400, { error: 'no-extId' }); return }
      const result = await routes.runtimeMsgSend(extId, parsed.payload)
      respondJson(200, { result })
    } catch (err) {
      log.warn('sw-rpc-server: runtime-msg-send threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-msg-poll' && req.method === 'GET') {
    const extId = new URL(url, 'http://x').searchParams.get('extId') ?? ''
    try {
      const payload = await routes.runtimeMsgPoll(extId, 25000)
      respondJson(200, payload ?? {})
    } catch (err) {
      log.warn('sw-rpc-server: runtime-msg-poll threw', { extId, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-connect' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { extId?: string; name?: string } : {}
      if (typeof parsed.extId !== 'string' || parsed.extId.length === 0) {
        respondJson(400, { error: 'no-extId' }); return
      }
      const portId = routes.portOpen(parsed.extId, typeof parsed.name === 'string' ? parsed.name : '')
      respondJson(200, { portId })
    } catch (err) {
      log.warn('sw-rpc-server: port-connect threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-content-send' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { portId?: string; message?: unknown } : {}
      if (typeof parsed.portId !== 'string') { respondJson(400, { error: 'no-portId' }); return }
      routes.portContentSend(parsed.portId, parsed.message)
      respondJson(200, { ok: true })
    } catch (err) {
      log.warn('sw-rpc-server: port-content-send threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-content-poll' && req.method === 'GET') {
    const portId = new URL(url, 'http://x').searchParams.get('portId') ?? ''
    try {
      const payload = await routes.portContentPoll(portId, 25000)
      respondJson(200, payload ?? {})
    } catch (err) {
      log.warn('sw-rpc-server: port-content-poll threw', { portId, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-sw-send' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { portId?: string; message?: unknown } : {}
      if (typeof parsed.portId !== 'string') { respondJson(400, { error: 'no-portId' }); return }
      routes.portSwSend(parsed.portId, parsed.message)
      respondJson(200, { ok: true })
    } catch (err) {
      log.warn('sw-rpc-server: port-sw-send threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-sw-poll' && req.method === 'GET') {
    const extId = new URL(url, 'http://x').searchParams.get('extId') ?? ''
    try {
      const payload = await routes.portSwPoll(extId, 25000)
      respondJson(200, payload ?? {})
    } catch (err) {
      log.warn('sw-rpc-server: port-sw-poll threw', { extId, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-port-disconnect' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { portId?: string; side?: string } : {}
      if (typeof parsed.portId !== 'string') { respondJson(400, { error: 'no-portId' }); return }
      const side = parsed.side === 'sw' ? 'sw' : 'content'
      routes.portDisconnect(parsed.portId, side)
      respondJson(200, { ok: true })
    } catch (err) {
      log.warn('sw-rpc-server: port-disconnect threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/userscripts-execute' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { extId?: string; injection?: Record<string, unknown> } : {}
      if (typeof parsed.extId !== 'string' || parsed.extId.length === 0) {
        respondJson(400, { error: 'no-extId' }); return
      }
      const results = await routes.userScriptsExecute(parsed.extId, parsed.injection ?? {})
      respondJson(200, { results })
    } catch (err) {
      log.warn('sw-rpc-server: userscripts-execute threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path === '/runtime-msg-respond' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const parsed = body ? JSON.parse(body) as { msgId?: string; response?: unknown } : {}
      if (typeof parsed.msgId === 'string') {
        routes.runtimeMsgRespond(parsed.msgId, parsed.response)
      }
      respondJson(200, { ok: true })
    } catch (err) {
      log.warn('sw-rpc-server: runtime-msg-respond threw', { err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  if (path.startsWith('/cookies/') && (req.method === 'GET' || req.method === 'POST')) {
    const op = path.slice('/cookies/'.length).replace(/\/+$/, '')
    let details: Record<string, unknown> = {}
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        details = body ? (JSON.parse(body) as Record<string, unknown>) : {}
      } else {
        const params = new URL(url, 'http://x').searchParams
        details = Object.fromEntries(params)
      }
    } catch (err) {
      log.warn('sw-rpc-server: cookies body parse failed', { op, err: String(err) })
      respondJson(400, { error: 'parse' })
      return
    }
    try {
      let result: unknown
      if (op === 'get') result = await routes.cookiesGet(partition, details as { url?: string; name?: string })
      else if (op === 'getAll') result = await routes.cookiesGetAll(partition, details)
      else if (op === 'set') result = await routes.cookiesSet(partition, details)
      else if (op === 'remove') result = await routes.cookiesRemove(partition, details as { url?: string; name?: string })
      else { respondJson(404, { error: 'unknown-cookies-op', op }); return }
      respondJson(200, { result })
    } catch (err) {
      log.warn('sw-rpc-server: cookies op threw', { op, err: String(err) })
      respondJson(500, { error: String(err) })
    }
    return
  }

  respondJson(404, { error: 'not-found', path })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', (err) => { reject(err) })
  })
}

/** Stop the server. Mostly for tests / teardown — production lifecycle
 *  spans the whole app session. */
export function stopSwRpcServer(): void {
  const s = server
  if (!s) return
  server = null
  started = null
  s.close((err) => {
    if (err) log.warn('sw-rpc-server: close errored', { err: String(err) })
  })
}
