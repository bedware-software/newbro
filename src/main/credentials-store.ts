// Saved HTTP-auth credentials for corporate sign-ins (Basic / Digest / NTLM /
// Negotiate). When Integrated Windows Authentication won't do — the Windows
// account this PC is logged into isn't the corporate account the server
// expects — the user can save explicit corp credentials once and have Newbro
// answer future 401/407 challenges for that host automatically, instead of
// retyping them on every launch.
//
// SECURITY:
//  - The password is encrypted at rest with Electron safeStorage (DPAPI on
//    Windows, Keychain on macOS). We never write a plaintext password to disk;
//    if OS encryption is unavailable we refuse to persist it.
//  - This store is deliberately NOT a cloud-sync category — these secrets stay
//    on the device that created them and never leave it. Do not add it to
//    SYNC_CATEGORIES / registerSyncCategory.

import Store from 'electron-store'
import { safeStorage } from 'electron'
import { log } from './log'

/** One saved sign-in, keyed by host. The cleartext password is only ever held
 *  in memory / handed to Chromium's login callback; on disk it lives encrypted
 *  in `passwordEnc`. */
interface SavedCredential {
  host: string
  username: string
  /** Base64 of the safeStorage ciphertext of the password. */
  passwordEnc: string
  /** Auth scheme that last saved this (basic|digest|ntlm|negotiate) — display only. */
  scheme: string
  /** Realm the server advertised, if any — display only. */
  realm: string
  updatedAt: number
}

/** Public, password-free view for the settings list and IPC. */
export interface SavedCredentialInfo {
  host: string
  username: string
  scheme: string
  realm: string
  updatedAt: number
}

const store = new Store<{ credentials: Record<string, SavedCredential> }>({
  name: 'newbro-credentials',
  defaults: { credentials: {} },
})

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

/** Look up a saved credential for `host` and decrypt its password. Returns
 *  undefined if none is stored or the ciphertext can't be decrypted (e.g. the
 *  OS keychain/DPAPI master changed after a profile move). Never throws. */
export function getCredential(host: string): { username: string; password: string } | undefined {
  try {
    const rec = store.get('credentials')[normalizeHost(host)]
    if (!rec) return undefined
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const password = safeStorage.decryptString(Buffer.from(rec.passwordEnc, 'base64'))
    return { username: rec.username, password }
  } catch (err) {
    log.warn('credentials: failed to read/decrypt', String(err))
    return undefined
  }
}

/** The stored username for `host` without touching the password — used to
 *  pre-fill the retry prompt when a saved credential was rejected. */
export function getSavedUsername(host: string): string | undefined {
  return store.get('credentials')[normalizeHost(host)]?.username
}

/** Persist (or replace) a saved sign-in. The password is encrypted with
 *  safeStorage; if that's unavailable we skip persisting and return false so the
 *  caller can tell the user "remember" didn't stick. Never throws. */
export function saveCredential(input: {
  host: string
  username: string
  password: string
  scheme?: string
  realm?: string
}): boolean {
  try {
    const host = normalizeHost(input.host)
    if (!host || !input.username) return false
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('credentials: OS encryption unavailable, not saving password', { host })
      return false
    }
    const passwordEnc = safeStorage.encryptString(input.password ?? '').toString('base64')
    const all = store.get('credentials')
    all[host] = {
      host,
      username: input.username,
      passwordEnc,
      scheme: input.scheme ?? '',
      realm: input.realm ?? '',
      updatedAt: Date.now(),
    }
    store.set('credentials', all)
    log.info('credentials: saved sign-in', { host, scheme: input.scheme })
    return true
  } catch (err) {
    log.warn('credentials: failed to save', String(err))
    return false
  }
}

export function deleteCredential(host: string): void {
  const all = store.get('credentials')
  const key = normalizeHost(host)
  if (key in all) {
    delete all[key]
    store.set('credentials', all)
  }
}

export function clearAllCredentials(): void {
  store.set('credentials', {})
}

/** Password-free list for the settings UI, sorted by host. */
export function listCredentials(): SavedCredentialInfo[] {
  return Object.values(store.get('credentials'))
    .map(({ host, username, scheme, realm, updatedAt }) => ({ host, username, scheme, realm, updatedAt }))
    .sort((a, b) => a.host.localeCompare(b.host))
}
