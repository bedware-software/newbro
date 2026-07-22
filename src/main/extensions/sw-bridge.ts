// Transport bridge between extension service workers and the main
// process, built on Electron 35+ service-worker preload realms and
// ServiceWorkerMain.ipc. This is the replacement for the legacy
// network-based transport (loopback HTTP sw-rpc-server, the
// `newbro-ext-ipc.test` sentinel host and the `newbro-ipc://`
// protocol): IPC cannot be intercepted by extension webRequest/DNR
// rules, does not consume the 6-connections-per-origin budget, and
// does not die on ERR_NETWORK_CHANGED.
//
// Wire protocol (all multiplexed over two channels so workers only
// ever need one handle() each):
//   SW → main  invoke: ipcRenderer.invoke('newbro-sw', channel, payload)
//              → { ok: true, data } | { ok: false, error }
//   SW → main  notify: ipcRenderer.send('newbro-sw-notify', channel, payload)
//   main → SW  push:   worker.send('newbro-sw-event', channel, payload)
//
// The preload realm (extension-shim.ts) exposes a `__newbroIpc`
// facade into the SW main world so the polyfill shim can call
// invoke/on without knowing about ipcRenderer.

import type { Session } from 'electron'
import { log } from '../log'

/** Structural type for Electron.ServiceWorkerMain — kept structural so
 *  we don't fight the fork's bundled electron type snapshots. */
interface SwMain {
  scope: string
  versionId: number
  ipc: {
    handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void
    on(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void
  }
  send(channel: string, ...args: unknown[]): void
}

export interface SwBridgeContext {
  partition: string
  extensionId: string
  worker: SwMain
  versionId: number
  markReady: () => void
}

type SwInvokeHandler = (ctx: SwBridgeContext, payload: unknown) => unknown | Promise<unknown>
type SwNotifyHandler = (ctx: SwBridgeContext, payload: unknown) => void

const invokeHandlers = new Map<string, SwInvokeHandler>()
const notifyHandlers = new Map<string, SwNotifyHandler>()

/** Register a request/response handler reachable from extension SWs as
 *  `__newbroIpc.invoke(channel, payload)`. Last registration wins —
 *  intentional, so a subsystem can replace its own handler on reload. */
export function registerSwInvokeHandler(channel: string, handler: SwInvokeHandler): void {
  if (invokeHandlers.has(channel)) {
    log.warn('sw-bridge: invoke handler replaced', { channel })
  }
  invokeHandlers.set(channel, handler)
}

/** Register a fire-and-forget handler for `__newbroIpc.notify(channel, payload)`. */
export function registerSwNotifyHandler(channel: string, handler: SwNotifyHandler): void {
  if (notifyHandlers.has(channel)) {
    log.warn('sw-bridge: notify handler replaced', { channel })
  }
  notifyHandlers.set(channel, handler)
}

// Live workers per session, keyed by versionId. Entries are dropped on
// the 'stopped' status so pushes never hit destroyed workers. `ready`
// flips true on the preload's 'hello' — before that the worker has no
// ipcRenderer listener for pushed events, so senders must treat the
// worker as unreachable and use their queue fallback.
const liveWorkers = new Map<Session, Map<number, { worker: SwMain; extensionId: string; ready: boolean }>>()
const wiredSessions = new WeakSet<Session>()
const sessionPartitions = new Map<Session, string>()

function extensionIdFromScope(scope: string): string {
  // chrome-extension://<id>/ → <id>
  try {
    return new URL(scope).hostname
  } catch {
    return scope.replace('chrome-extension://', '').replace(/\/.*$/, '')
  }
}

/** Push an event to extension service workers that have completed the
 *  preload handshake. `extensionId === null` broadcasts to every ready
 *  worker; `partition === null` spans all wired sessions. `mode:
 *  'first'` stops after one delivery (single-consumer queues); 'all'
 *  fans out (auth challenges). Returns the number of workers reached —
 *  0 tells the caller to fall back to its poll-drained queue. */
export function sendToExtensionWorkers(
  partition: string | null,
  extensionId: string | null,
  channel: string,
  payload: unknown,
  mode: 'all' | 'first' = 'all',
): number {
  let reached = 0
  for (const [ses, workers] of liveWorkers) {
    if (partition !== null && sessionPartitions.get(ses) !== partition) continue
    for (const { worker, extensionId: id, ready } of workers.values()) {
      if (extensionId !== null && id !== extensionId) continue
      if (!ready) continue
      try {
        worker.send('newbro-sw-event', channel, payload)
        reached++
        if (mode === 'first') return reached
      } catch (err) {
        // Worker likely tore down between status events — log, keep going.
        log.warn('sw-bridge: push failed', { channel, id, err: String(err) })
      }
    }
  }
  return reached
}

/** Attach the bridge to a partition session. Idempotent. Must run
 *  before extensions load so no 'starting' status is missed. */
export function wireServiceWorkerBridge(ses: Session, partition: string): void {
  if (wiredSessions.has(ses)) return
  wiredSessions.add(ses)
  sessionPartitions.set(ses, partition)
  liveWorkers.set(ses, new Map())

  const serviceWorkers = (ses as unknown as {
    serviceWorkers: {
      on(event: string, listener: (details: { versionId: number; runningStatus: string }) => void): void
      getWorkerFromVersionID(versionId: number): SwMain | undefined
    }
  }).serviceWorkers

  serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    const workers = liveWorkers.get(ses)
    if (!workers) return

    if (runningStatus === 'stopped') {
      if (workers.delete(versionId)) {
        log.info('sw-bridge: worker stopped', { partition, versionId })
      }
      return
    }
    if (runningStatus !== 'starting') return

    const worker = serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || !worker.scope?.startsWith('chrome-extension://')) return
    if (workers.has(versionId)) return

    const extensionId = extensionIdFromScope(worker.scope)
    const entry = { worker, extensionId, ready: false }
    const ctx: SwBridgeContext = {
      partition,
      extensionId,
      worker,
      versionId,
      markReady: () => {
        entry.ready = true
      },
    }
    workers.set(versionId, entry)

    try {
      worker.ipc.handle('newbro-sw', async (_event, channel: unknown, payload: unknown) => {
        const ch = String(channel)
        const handler = invokeHandlers.get(ch)
        if (!handler) {
          log.warn('sw-bridge: no invoke handler', { partition, extensionId, channel: ch })
          return { ok: false, error: `no handler for '${ch}'` }
        }
        try {
          const data = await handler(ctx, payload)
          return { ok: true, data }
        } catch (err) {
          log.warn('sw-bridge: invoke handler threw', {
            partition,
            extensionId,
            channel: ch,
            err: String(err),
          })
          return { ok: false, error: String(err) }
        }
      })
      worker.ipc.on('newbro-sw-notify', (_event, channel: unknown, payload: unknown) => {
        const ch = String(channel)
        const handler = notifyHandlers.get(ch)
        if (!handler) {
          log.warn('sw-bridge: no notify handler', { partition, extensionId, channel: ch })
          return
        }
        try {
          handler(ctx, payload)
        } catch (err) {
          log.warn('sw-bridge: notify handler threw', {
            partition,
            extensionId,
            channel: ch,
            err: String(err),
          })
        }
      })
      log.info('sw-bridge: wired worker', { partition, extensionId, versionId })
    } catch (err) {
      // ipc.handle can throw on double-registration if Chromium reuses a
      // versionId — surface it, the worker keeps its previous handlers.
      log.warn('sw-bridge: failed to wire worker', {
        partition,
        extensionId,
        versionId,
        err: String(err),
      })
    }
  })

  log.info('sw-bridge: session wired', { partition })
}

// ── Built-in channels ──

// Handshake: proves preload realm + IPC round-trip for a worker and
// marks it push-ready (the preload registers its event listener before
// invoking hello, so pushes can't outrun it).
registerSwInvokeHandler('hello', (ctx, payload) => {
  ctx.markReady()
  log.info('sw-bridge: hello', {
    partition: ctx.partition,
    extensionId: ctx.extensionId,
    versionId: ctx.versionId,
    payload,
  })
  return { partition: ctx.partition, extensionId: ctx.extensionId, ts: Date.now() }
})

// Diagnostics from the SW shim (replaces the sw-shim-error HTTP beacon).
registerSwNotifyHandler('log', (ctx, payload) => {
  log.info('sw-bridge: sw log', {
    partition: ctx.partition,
    extensionId: ctx.extensionId,
    payload,
  })
})
