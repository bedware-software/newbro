// HTTP authentication for server challenges (Basic / Digest / NTLM / Negotiate).
// When a site responds 401 with WWW-Authenticate, Electron fires
// app.on('login'); if nobody supplies credentials the request is cancelled and
// the page stays at 401. This module answers the challenge, feeding credentials
// back to Chromium's login callback:
//
//   1. If the user has SAVED a credential for the host, answer it silently —
//      no dialog (the corp mail / intranet "just works" after the first time).
//      This is how explicit corporate credentials get used even when Integrated
//      Windows Auth (the ambient PC account) is the wrong identity.
//   2. Otherwise drive a renderer credentials dialog (like the native prompt
//      Edge shows) and feed the answer back. If "remember" is ticked, the
//      credential is saved (encrypted) for next time.
//
// Only SERVER auth for real tabs routes here — proxy / extension-service-worker
// challenges keep their existing handling in index.ts.

import { BrowserWindow, ipcMain } from 'electron'
import { log } from './log'
import { getCredential, getSavedUsername, saveCredential } from './credentials-store'

interface Pending {
  // Concurrent challenges for the same window+host share one dialog; every
  // parked callback is answered with the same result.
  callbacks: Array<(username?: string, password?: string) => void>
  timer: ReturnType<typeof setTimeout>
  key: string
  host: string
  scheme: string
  realm: string
}

// Active prompts keyed by the prompt id the renderer echoes back.
const pending = new Map<string, Pending>()
// De-dupe index: window+host → prompt id, so a burst of subresource 401s on one
// host shows a single dialog rather than a storm.
const promptByHost = new Map<string, string>()
// Hosts we've already auto-answered with a saved credential this challenge
// sequence (window+host → timestamp). Guarantees a wrong saved credential is
// tried at most once, then falls through to a prompt instead of looping.
// The TTL only has to outlast the gap between our callback and the server's
// re-challenge on rejection (near-immediate). Kept short on purpose: after a
// *successful* auth Chromium caches the credential and won't re-fire, so a long
// TTL would only serve to force a needless prompt if the site legitimately
// re-challenges (e.g. a session refresh) minutes later.
const triedSaved = new Map<string, number>()
const TRIED_SAVED_TTL_MS = 15000

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

function hostKey(winId: number, host: string): string {
  return `${winId}|${host}`
}

function gcTriedSaved(): void {
  const now = Date.now()
  for (const [k, at] of triedSaved) {
    if (now - at > TRIED_SAVED_TTL_MS) triedSaved.delete(k)
  }
}

/** Entry point from app.on('login') for SERVER auth on a real tab. Answers
 *  automatically with a saved credential when one exists (and hasn't just been
 *  rejected); otherwise prompts the user via the renderer dialog. Cancels (401)
 *  on dismiss or timeout. Never throws — a store failure must never wedge auth. */
export function handleServerAuth(
  win: BrowserWindow,
  url: string,
  authInfo: ServerAuthInfo,
  callback: (username?: string, password?: string) => void,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    callback()
    return
  }

  let host = authInfo.host
  try { host = new URL(url).host } catch { /* fall back to authInfo.host */ }
  const key = hostKey(win.id, host)

  // 1. Try a saved credential once per challenge sequence. If it's wrong,
  //    app.on('login') re-fires; triedSaved is now set so we fall to the prompt.
  try {
    gcTriedSaved()
    if (!triedSaved.has(key)) {
      const saved = getCredential(host)
      if (saved) {
        triedSaved.set(key, Date.now())
        log.info('http-auth: answering with saved credential', { host, scheme: authInfo.scheme })
        callback(saved.username, saved.password)
        return
      }
    }
  } catch (err) {
    log.warn('http-auth: saved-credential lookup failed', String(err))
  }

  // 2. If a dialog for this window+host is already open, ride along with it so
  //    a page's many subresource challenges don't stack N dialogs.
  const existingId = promptByHost.get(key)
  if (existingId) {
    const entry = pending.get(existingId)
    if (entry) {
      entry.callbacks.push(callback)
      return
    }
    promptByHost.delete(key)
  }

  // 3. Prompt the user.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const timer = setTimeout(() => {
    const entry = pending.get(id)
    if (entry) {
      pending.delete(id)
      promptByHost.delete(key)
      log.warn('http-auth: prompt timed out, cancelling', { url })
      for (const cb of entry.callbacks) cb()
    }
  }, AUTH_TIMEOUT_MS)
  pending.set(id, { callbacks: [callback], timer, key, host, scheme: authInfo.scheme, realm: authInfo.realm })
  promptByHost.set(key, id)

  // A saved username present here means the saved credential was just rejected
  // (we auto-tried it above and login re-fired) — pre-fill it and let the dialog
  // say so.
  const savedUsername = triedSaved.has(key) ? getSavedUsername(host) : undefined

  win.webContents.send('http-auth:request', {
    id,
    url,
    host,
    port: authInfo.port,
    realm: authInfo.realm,
    scheme: authInfo.scheme,
    isProxy: authInfo.isProxy,
    savedUsername,
    hadSavedCredential: !!savedUsername,
    // Proxy credentials aren't routed here, but guard anyway: only offer to
    // remember real server sign-ins.
    canSave: !authInfo.isProxy,
  })
  log.info('http-auth: prompting', { url, scheme: authInfo.scheme, isProxy: authInfo.isProxy })
}

export function registerHttpAuthIpc(): void {
  ipcMain.handle(
    'http-auth:respond',
    (
      _e,
      resp: { id: string; username?: string; password?: string; remember?: boolean; cancel?: boolean },
    ) => {
      const entry = pending.get(resp?.id)
      if (!entry) return
      pending.delete(resp.id)
      clearTimeout(entry.timer)
      if (promptByHost.get(entry.key) === resp.id) promptByHost.delete(entry.key)

      if (resp.cancel || typeof resp.username !== 'string') {
        for (const cb of entry.callbacks) cb()
        return
      }

      const username = resp.username
      const password = resp.password ?? ''
      if (resp.remember) {
        saveCredential({ host: entry.host, username, password, scheme: entry.scheme, realm: entry.realm })
      }
      for (const cb of entry.callbacks) cb(username, password)
    },
  )
}
