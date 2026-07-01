// HTTP authentication prompt for server challenges (Basic / Digest / NTLM /
// Negotiate). When a site responds 401 with WWW-Authenticate, Electron fires
// app.on('login'); if nobody supplies credentials the request is cancelled and
// the page stays at 401. This module drives a renderer credentials dialog (like
// the native prompt Edge shows) and feeds the answer back to Chromium.
//
// Only SERVER auth for real tabs routes here — proxy / extension-service-worker
// challenges keep their existing handling in index.ts.

import { BrowserWindow, ipcMain } from 'electron'
import { log } from './log'

interface Pending {
  callback: (username?: string, password?: string) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

// Generous — the user may need time to fetch credentials. If they never answer
// we cancel (401) rather than leave the request hanging forever.
const AUTH_TIMEOUT_MS = 180000

export interface ServerAuthInfo {
  isProxy: boolean
  scheme: string
  host: string
  port: number
  realm: string
}

/** Prompt for HTTP credentials in `win`'s renderer, then hand them to
 *  Chromium's login `callback`. Cancels (401) on dismiss or timeout. */
export function promptServerAuth(
  win: BrowserWindow,
  url: string,
  authInfo: ServerAuthInfo,
  callback: (username?: string, password?: string) => void,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    callback()
    return
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const timer = setTimeout(() => {
    if (pending.delete(id)) {
      log.warn('http-auth: prompt timed out, cancelling', { url })
      callback()
    }
  }, AUTH_TIMEOUT_MS)
  pending.set(id, { callback, timer })

  let host = authInfo.host
  try { host = new URL(url).host } catch { /* fall back to authInfo.host */ }

  win.webContents.send('http-auth:request', {
    id,
    url,
    host,
    port: authInfo.port,
    realm: authInfo.realm,
    scheme: authInfo.scheme,
    isProxy: authInfo.isProxy,
  })
  log.info('http-auth: prompting', { url, scheme: authInfo.scheme, isProxy: authInfo.isProxy })
}

export function registerHttpAuthIpc(): void {
  ipcMain.handle(
    'http-auth:respond',
    (_e, resp: { id: string; username?: string; password?: string; cancel?: boolean }) => {
      const entry = pending.get(resp?.id)
      if (!entry) return
      pending.delete(resp.id)
      clearTimeout(entry.timer)
      if (resp.cancel || typeof resp.username !== 'string') {
        entry.callback()
      } else {
        entry.callback(resp.username, resp.password ?? '')
      }
    },
  )
}
