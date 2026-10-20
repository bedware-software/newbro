// Passkeys held by Newbro's own platform authenticator (see webauthn.ts).
//
// macOS hands iCloud Keychain passkeys only to browsers Apple entitles, and
// Chromium's Touch ID authenticator (Electron's app.configureWebAuthn) needs a
// keychain-access-groups entitlement that an ad-hoc signed app can't carry —
// macOS kills it at launch. So Newbro keeps its passkeys itself: one P-256 key
// pair per credential, the private key encrypted with the OS vault like saved
// passwords, scoped to one profile. They stay on this device: no export, no
// Cloud Sync.

import Store from 'electron-store'
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'crypto'
import { decryptSecret, encryptSecret, normalizePartition } from './password-store'

interface StoredPasskey {
  /** Credential ID, base64url. */
  id: string
  partition: string
  rpId: string
  /** The site's user handle, base64url. */
  userId: string
  userName: string
  userDisplayName: string
  /** PKCS#8 DER private key, base64, encrypted with the OS vault. */
  privateKeyEnc: string
  createdAt: number
  lastUsedAt: number
}

export interface PasskeyInfo {
  id: string
  partition: string
  rpId: string
  userId: string
  userName: string
  userDisplayName: string
  createdAt: number
  lastUsedAt: number
}

export interface CreatedPasskey {
  id: Buffer
  /** Uncompressed P-256 point coordinates, for the COSE key. */
  x: Buffer
  y: Buffer
  /** SubjectPublicKeyInfo DER, for getPublicKey(). */
  spki: Buffer
}

const store = new Store<{ entries: Record<string, StoredPasskey> }>({
  name: 'newbro-passkeys',
  defaults: { entries: {} },
})

function publicInfo(entry: StoredPasskey): PasskeyInfo {
  const { id, partition, rpId, userId, userName, userDisplayName, createdAt, lastUsedAt } = entry
  return { id, partition, rpId, userId, userName, userDisplayName, createdAt, lastUsedAt }
}

export function listPasskeys(partition: string): PasskeyInfo[] {
  const normalized = normalizePartition(partition)
  return Object.values(store.get('entries'))
    .filter((entry) => entry.partition === normalized)
    .map(publicInfo)
    .sort((a, b) => a.rpId.localeCompare(b.rpId) || a.userName.localeCompare(b.userName))
}

/** The profile's passkeys for a site, most recently used first. */
export function passkeysForRp(partition: string, rpId: string): PasskeyInfo[] {
  const normalized = normalizePartition(partition)
  return Object.values(store.get('entries'))
    .filter((entry) => entry.partition === normalized && entry.rpId === rpId)
    .map(publicInfo)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt)
}

/** Makes a new passkey. Like any authenticator, a site and user handle hold
 *  one discoverable credential: a second registration replaces the first. */
export async function createPasskey(input: {
  partition: string
  rpId: string
  userId: string
  userName: string
  userDisplayName: string
}): Promise<CreatedPasskey> {
  const partition = normalizePartition(input.partition)
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' })
  if (!jwk.x || !jwk.y) throw new Error('The new passkey has no public key.')
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  const id = randomBytes(16)
  const now = Date.now()
  const entry: StoredPasskey = {
    id: id.toString('base64url'),
    partition,
    rpId: input.rpId,
    userId: input.userId,
    userName: input.userName.slice(0, 512),
    userDisplayName: input.userDisplayName.slice(0, 512),
    privateKeyEnc: await encryptSecret(pkcs8.toString('base64')),
    createdAt: now,
    lastUsedAt: 0,
  }
  const entries = { ...store.get('entries') }
  for (const existing of Object.values(entries)) {
    if (existing.partition === partition && existing.rpId === entry.rpId && existing.userId === entry.userId) {
      delete entries[existing.id]
    }
  }
  entries[entry.id] = entry
  store.set('entries', entries)
  return {
    id,
    x: Buffer.from(jwk.x, 'base64url'),
    y: Buffer.from(jwk.y, 'base64url'),
    spki: publicKey.export({ type: 'spki', format: 'der' }),
  }
}

/** Signs `data` with the passkey's private key: ES256, DER-encoded, as
 *  WebAuthn assertions carry it. The caller has already verified the user. */
export async function signWithPasskey(partition: string, id: string, data: Buffer): Promise<Buffer> {
  const normalized = normalizePartition(partition)
  const entries = store.get('entries')
  const entry = entries[id]
  if (!entry || entry.partition !== normalized) throw new Error('Passkey not found.')
  const key = createPrivateKey({
    key: Buffer.from(await decryptSecret(entry.privateKeyEnc), 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const signature = sign('sha256', data, { key, dsaEncoding: 'der' })
  store.set('entries', { ...entries, [id]: { ...entry, lastUsedAt: Date.now() } })
  return signature
}

export function deletePasskey(partition: string, id: string): void {
  const normalized = normalizePartition(partition)
  const entries = { ...store.get('entries') }
  if (entries[id]?.partition !== normalized) return
  delete entries[id]
  store.set('entries', entries)
}
