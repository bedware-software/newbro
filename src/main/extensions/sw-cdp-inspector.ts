// Self-attaching CDP (Chrome DevTools Protocol) inspector for the
// extension service workers running inside this Electron app. Pipes
// the same Network events you'd see in a DevTools "Network" tab into
// the project's main log, so a SW fetch failure surfaces with its
// full `errorText` (e.g. `net::ERR_BLOCKED_BY_CLIENT`,
// `net::ERR_NAME_NOT_RESOLVED`) instead of the SW-side fetch's opaque
// "Failed to fetch" TypeError.
//
// Why this exists: the JS fetch API in a SW only surfaces "Failed to
// fetch" — the underlying Chromium net error code never reaches the
// JS world. The browser's Network panel knows it because it consumes
// CDP events, and we can do the exact same thing programmatically by
// connecting to our own remote-debugging-port (set in index.ts to
// 9229).
//
// Lifecycle:
//   1. After app is ready, poll /json/list to find current targets.
//   2. For every NEW target whose type is 'service_worker', open a
//      WebSocket to its webSocketDebuggerUrl.
//   3. Send {Runtime,Network}.enable so the target streams events.
//   4. Forward Network.requestWillBeSent / responseReceived /
//      loadingFinished / loadingFailed into log.info / log.warn.
//   5. Re-poll periodically for new targets (SWs come and go on
//      Chromium-driven restarts).
//
// We don't need an external Chrome or chrome://inspect for this; the
// connection stays inside the same process as the app.
//
// We ALSO use this CDP attach point to handle proxy auth challenges
// for SW-initiated fetches. Electron 41 doesn't surface
// webRequest.onAuthRequired or session.on('login') — only
// app.on('login'), which is webContents-scoped and doesn't fire for
// MV3 service worker fetches. Without auth handling, Browsec's
// webstat.me SmartSettings ping (and any other SW-initiated request
// going through its proxy) loops forever on 407 Proxy Authentication
// Required, the country picker UI shows a permanent "loading"
// spinner, and the toolbar icon never updates to the connected-
// country flag. CDP's `Fetch` domain DOES fire authRequired for SW
// fetches; we enable it with `handleAuthRequests: true` and route
// the challenge through the same auth-poll machinery the SW shim
// already uses for webContents-scoped challenges.

import { log } from '../log'

const CDP_HOST = '127.0.0.1'
const CDP_PORT = 9229
const POLL_MS = 2000

type CdpTarget = {
  id: string
  type: string
  url: string
  title?: string
  webSocketDebuggerUrl?: string
}

type CdpEvent = {
  id?: number
  method?: string
  params?: Record<string, unknown>
  error?: { code?: number; message?: string }
  result?: Record<string, unknown>
}

const attached = new Map<string, WebSocket>()
let pollerStarted = false

/** Auth-challenge router supplied by main. Receives the CDP
 *  Fetch.authRequired details + a `respond` function we use to
 *  forward the credentials back to CDP via Fetch.continueWithAuth.
 *  Set via setSwCdpAuthHandler before any SWs come up. */
export type SwCdpAuthDetails = {
  url: string
  isProxy: boolean
  scheme?: string
  realm?: string
  challenger: { host?: string; port?: number }
  swTargetId: string
  swUrl: string
}
export type SwCdpAuthResponse =
  | { username: string; password: string }
  | { cancel: true }
  | null
let authHandler: ((details: SwCdpAuthDetails, respond: (resp: SwCdpAuthResponse) => void) => void) | null = null
export function setSwCdpAuthHandler(
  handler: (details: SwCdpAuthDetails, respond: (resp: SwCdpAuthResponse) => void) => void,
): void {
  authHandler = handler
}

/** Begin self-inspection. Idempotent. Safe to call before the
 *  remote-debugging socket is ready — we'll simply find nothing on
 *  the first poll and pick up SWs on a later tick. */
export function startSwCdpInspector(): void {
  if (pollerStarted) return
  pollerStarted = true
  log.info('cdp-inspector: starting', { host: CDP_HOST, port: CDP_PORT })
  void poll()
  setInterval(() => { void poll() }, POLL_MS)
}

async function poll(): Promise<void> {
  let targets: CdpTarget[]
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`)
    if (!resp.ok) {
      log.warn('cdp-inspector: /json/list failed', { status: resp.status })
      return
    }
    targets = (await resp.json()) as CdpTarget[]
  } catch (err) {
    // Remote-debugging-port not up yet, or socket transient — log
    // sparingly so we don't flood during shutdown.
    log.warn('cdp-inspector: /json/list fetch threw', { err: String(err) })
    return
  }
  const seen = new Set<string>()
  for (const t of targets) {
    if (t.type !== 'service_worker') continue
    if (!t.webSocketDebuggerUrl) continue
    seen.add(t.id)
    if (attached.has(t.id)) continue
    attachToTarget(t)
  }
  // Drop dead targets so the WeakMap doesn't grow unboundedly.
  for (const id of [...attached.keys()]) {
    if (!seen.has(id)) {
      try { attached.get(id)?.close() }
      catch (err) { log.warn('cdp-inspector: stale ws close threw', { id, err: String(err) }) }
      attached.delete(id)
    }
  }
}

function attachToTarget(t: CdpTarget): void {
  if (!t.webSocketDebuggerUrl) return
  log.info('cdp-inspector: attaching to SW target', { id: t.id, url: t.url })
  let ws: WebSocket
  try {
    ws = new WebSocket(t.webSocketDebuggerUrl)
  } catch (err) {
    log.warn('cdp-inspector: WebSocket constructor threw', { id: t.id, err: String(err) })
    return
  }
  attached.set(t.id, ws)

  // Track in-flight requests by requestId so loadingFailed can name
  // the URL/method that failed (loadingFailed only carries the
  // requestId + errorText).
  const inflight = new Map<string, { url: string; method: string; t0: number }>()

  let nextId = 1
  const send = (method: string, params?: Record<string, unknown>): void => {
    if (ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ id: nextId++, method, params }))
    } catch (err) {
      log.warn('cdp-inspector: ws.send threw', { method, err: String(err) })
    }
  }

  ws.addEventListener('open', () => {
    log.info('cdp-inspector: ws open', { id: t.id, url: t.url })
    send('Network.enable')
    send('Runtime.enable')
    // Fetch.enable with handleAuthRequests=true and an empty
    // patterns list: we ONLY want to be notified of auth challenges
    // and never want CDP to pause general requests. Without this,
    // proxy 407s for SW-initiated fetches go unhandled (Electron 41
    // doesn't expose webRequest.onAuthRequired or session.on('login'),
    // and app.on('login') doesn't fire for MV3 SW contexts). With it,
    // we get a Fetch.authRequired event, forward the challenge to the
    // SW shim's auth-poll, get credentials back, and continue the
    // request via Fetch.continueWithAuth — same auth flow as
    // webContents-scoped challenges, just routed through CDP.
    send('Fetch.enable', { patterns: [], handleAuthRequests: true })
  })

  ws.addEventListener('message', (event: MessageEvent) => {
    let parsed: CdpEvent
    try { parsed = JSON.parse(String(event.data)) }
    catch (err) {
      log.warn('cdp-inspector: ws message JSON parse failed', { err: String(err) })
      return
    }
    if (!parsed.method) return // command ack — ignore
    const params = parsed.params ?? {}
    const reqId = String(params['requestId'] ?? '')
    if (parsed.method === 'Network.requestWillBeSent') {
      const req = params['request'] as { url?: string; method?: string } | undefined
      if (reqId && req?.url) {
        inflight.set(reqId, { url: String(req.url), method: String(req.method ?? 'GET'), t0: Date.now() })
      }
    } else if (parsed.method === 'Network.responseReceived') {
      const resp = params['response'] as { status?: number; statusText?: string } | undefined
      const known = inflight.get(reqId)
      log.info('sw network response', {
        target: t.id,
        url: known?.url ?? '(unknown)',
        method: known?.method ?? '?',
        status: resp?.status,
        statusText: resp?.statusText,
        ms: known ? Date.now() - known.t0 : undefined,
      })
    } else if (parsed.method === 'Network.loadingFinished') {
      // We already log responseReceived; finished is just "all bytes
      // delivered". Drop the inflight entry so the map stays bounded.
      inflight.delete(reqId)
    } else if (parsed.method === 'Network.loadingFailed') {
      const errorText = String(params['errorText'] ?? '')
      const known = inflight.get(reqId)
      inflight.delete(reqId)
      log.warn('sw network FAILED', {
        target: t.id,
        url: known?.url ?? '(unknown)',
        method: known?.method ?? '?',
        errorText,
        canceled: params['canceled'],
        type: params['type'],
        ms: known ? Date.now() - known.t0 : undefined,
      })
    } else if (parsed.method === 'Fetch.authRequired') {
      // Fetch.authRequired schema: { requestId, request, frameId,
      //   resourceType, authChallenge: { source, origin, scheme, realm } }
      const fetchReqId = String(params['requestId'] ?? '')
      const req = params['request'] as { url?: string } | undefined
      const ch = params['authChallenge'] as
        | { source?: string; origin?: string; scheme?: string; realm?: string }
        | undefined
      const isProxy = ch?.source === 'Proxy'
      // origin is a URL string (e.g. "https://nl470.quickcache.space:5280"); split for telemetry.
      let challengerHost: string | undefined
      let challengerPort: number | undefined
      try {
        if (ch?.origin) {
          const u = new URL(ch.origin)
          challengerHost = u.hostname
          challengerPort = u.port ? Number(u.port) : undefined
        }
      } catch (err) {
        log.warn('cdp-inspector: authChallenge origin parse failed', { origin: ch?.origin, err: String(err) })
      }
      log.info('cdp-inspector: Fetch.authRequired', {
        target: t.id,
        url: req?.url,
        isProxy,
        scheme: ch?.scheme,
        challenger: { host: challengerHost, port: challengerPort },
        hasHandler: !!authHandler,
      })
      if (!authHandler) {
        // No handler wired yet — fail closed so the request doesn't hang.
        send('Fetch.continueWithAuth', {
          requestId: fetchReqId,
          authChallengeResponse: { response: 'CancelAuth' },
        })
        return
      }
      let answered = false
      const respond = (resp: SwCdpAuthResponse): void => {
        if (answered) return
        answered = true
        if (resp && 'username' in resp) {
          send('Fetch.continueWithAuth', {
            requestId: fetchReqId,
            authChallengeResponse: {
              response: 'ProvideCredentials',
              username: resp.username,
              password: resp.password,
            },
          })
        } else {
          send('Fetch.continueWithAuth', {
            requestId: fetchReqId,
            authChallengeResponse: { response: 'CancelAuth' },
          })
        }
      }
      try {
        authHandler(
          {
            url: req?.url ?? '',
            isProxy,
            scheme: ch?.scheme,
            realm: ch?.realm,
            challenger: { host: challengerHost, port: challengerPort },
            swTargetId: t.id,
            swUrl: t.url,
          },
          respond,
        )
      } catch (err) {
        log.warn('cdp-inspector: authHandler threw', { err: String(err) })
        respond({ cancel: true })
      }
    }
  })

  ws.addEventListener('close', () => {
    log.info('cdp-inspector: ws closed', { id: t.id })
    attached.delete(t.id)
  })

  ws.addEventListener('error', (event: Event) => {
    // Most WS errors are followed by a close — log so we know which
    // target lost its inspector.
    log.warn('cdp-inspector: ws error', { id: t.id, type: event.type })
  })
}
