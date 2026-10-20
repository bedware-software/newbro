// Passkeys (WebAuthn) for tab pages on macOS: Newbro's own Touch ID platform
// authenticator.
//
// Electron services navigator.credentials on macOS only through Chromium's
// Touch ID authenticator, which needs a keychain entitlement an ad-hoc signed
// Newbro can't carry (passkey-store.ts). Without it a ceremony finds no
// authenticator and the page waits until it times out, so a site's passkey
// check never completes. Instead the tab preload (webauthn-bridge.ts) routes
// the page's publicKey requests here, and this module plays both parts:
//
//   - the browser: the origin comes from the invoking frame, never from the
//     page; the RP ID is checked against it, the client data JSON is written
//     here, and the user picks an account and confirms with Touch ID;
//   - the authenticator: keys from passkey-store.ts, "none" attestation, no
//     signature counter (always 0, as synced passkeys report).
//
// Passkeys in iCloud Keychain (Safari, the Passwords app) or on a phone stay
// out of reach — macOS gives those only to browsers Apple entitles. A site
// that asks only for one of those gets a note saying so, then NotAllowedError,
// so it can offer its other ways to sign in.

import { BrowserWindow, dialog, ipcMain, systemPreferences } from 'electron'
import type { MessageBoxOptions, Session, WebContents } from 'electron'
import { createHash } from 'crypto'
import { log } from './log'
import { createPasskey, deletePasskey, listPasskeys, passkeysForRp, signWithPasskey } from './passkey-store'
import type { PasskeyInfo } from './passkey-store'
import { getWindowForTabWebContents } from './tab-views'
import { isAppUiSender } from './vault-access'

interface CredentialDescriptor {
  id: string
  transports?: string[]
}

// What the bridge sends: the page's options with every BufferSource as
// base64url. Untrusted — each field is checked before use.
interface CreateRequest {
  requestId?: string
  challenge?: unknown
  rp?: { id?: unknown; name?: unknown }
  user?: { id?: unknown; name?: unknown; displayName?: unknown }
  pubKeyCredParams?: unknown
  excludeCredentials?: unknown
  userVerification?: unknown
  credProps?: unknown
}

interface GetRequest {
  requestId?: string
  challenge?: unknown
  rpId?: unknown
  allowCredentials?: unknown
  userVerification?: unknown
}

type Failure = { ok: false; name: string; message: string } | { ok: false; native: true }

interface Context {
  wc: WebContents
  partition: string
  origin: string
  host: string
}

/** Rejects the page's promise with this DOMException name (or TypeError). */
class CeremonyError extends Error {
  constructor(readonly domName: string, message: string) {
    super(message)
  }
}

/** Hands the request back to Chromium's own WebAuthn (security keys). */
class NativeFallback extends Error {}

const NOT_ALLOWED = 'The operation either timed out or was not allowed.'

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40
const COSE_ES256 = -7
// "none" attestation carries no authenticator model, so the AAGUID is zeros.
const AAGUID = Buffer.alloc(16)

// Two-label public suffixes (co.uk, com.au, …). Without the full Public
// Suffix List this covers the common case of an RP ID that would span many
// unrelated sites; the server also checks the origin in the client data.
const SECOND_LEVEL_SUFFIX = /^(ac|co|com|edu|gov|ltd|mil|ne|net|or|org|plc|sch)\.[a-z]{2}$/

const NO_PASSKEY_DETAIL =
  'Newbro can only use passkeys it saved itself. Passkeys in iCloud Keychain (Safari, the Passwords app) ' +
  'or on your phone aren\'t available to Newbro: macOS gives them only to browsers Apple approves.\n\n' +
  'Choose another way to sign in on the page. To use Touch ID here next time, add a passkey for Newbro ' +
  'in the site\'s security settings.'

// One ceremony per tab at a time, like Chromium ("A request is already pending").
const active = new Map<number, { requestId: string; controller: AbortController }>()

function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

// ── CBOR (the subset WebAuthn needs, in CTAP2 canonical key order) ──

type CborValue = number | string | Buffer | Map<CborValue, CborValue>

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  if (length < 0x10000) {
    const head = Buffer.alloc(3)
    head[0] = (major << 5) | 25
    head.writeUInt16BE(length, 1)
    return head
  }
  const head = Buffer.alloc(5)
  head[0] = (major << 5) | 26
  head.writeUInt32BE(length, 1)
  return head
}

function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  const parts = [cborHead(5, value.size)]
  for (const [key, item] of value) parts.push(cbor(key), cbor(item))
  return Buffer.concat(parts)
}

// ── Request checks ──

function bytes(value: unknown, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new CeremonyError('TypeError', `${field} is not a BufferSource.`)
  }
  return Buffer.from(value, 'base64url')
}

function text(value: unknown, max = 512): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function descriptors(value: unknown): CredentialDescriptor[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 256).flatMap((item) => {
    const id = (item as { id?: unknown })?.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return []
    const transports = (item as { transports?: unknown }).transports
    return [{
      // Normalize: the page may encode with or without padding variants.
      id: Buffer.from(id, 'base64url').toString('base64url'),
      transports: Array.isArray(transports) ? transports.filter((t): t is string => typeof t === 'string') : undefined,
    }]
  })
}

function isSecureOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname
  return host === 'localhost' || host.endsWith('.localhost')
}

function rpIdFor(value: unknown, host: string): string {
  if (value === undefined || value === null) return host
  const raw = typeof value === 'string' ? value.trim() : ''
  let rpId = ''
  try {
    if (raw && !/[/:?#@\s\\]/.test(raw)) rpId = new URL(`https://${raw}`).hostname
  } catch {
    rpId = ''
  }
  const valid = rpId === host || (
    rpId !== '' && host.endsWith(`.${rpId}`) && rpId.includes('.') && !SECOND_LEVEL_SUFFIX.test(rpId)
  )
  if (!valid) {
    throw new CeremonyError('SecurityError', 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.')
  }
  return rpId
}

function requestContext(event: Electron.IpcMainInvokeEvent, getPartition: (ses: Session) => string): Context {
  const frame = event.senderFrame
  if (!frame) throw new CeremonyError('NotAllowedError', 'The document is no longer active.')
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    throw new CeremonyError('SecurityError', 'This document has no valid origin.')
  }
  if (!isSecureOrigin(url)) throw new CeremonyError('SecurityError', 'Passkeys need a secure (HTTPS) page.')
  if (/^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith('[')) {
    throw new CeremonyError('SecurityError', 'This is an invalid domain.')
  }
  if (frame !== event.sender.mainFrame && url.origin !== new URL(event.sender.mainFrame.url).origin) {
    throw new CeremonyError('NotAllowedError', 'Passkeys aren\'t available in cross-origin frames.')
  }
  const partition = getPartition(event.sender.session)
  if (!partition.startsWith('persist:profile-')) {
    throw new CeremonyError('NotAllowedError', 'Passkeys aren\'t available in this window.')
  }
  return { wc: event.sender, partition, origin: url.origin, host: url.hostname }
}

// ── User interaction ──

async function ask(ctx: Context, options: MessageBoxOptions, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw new CeremonyError('AbortError', 'The operation was aborted.')
  const win = getWindowForTabWebContents(ctx.wc) ?? BrowserWindow.fromWebContents(ctx.wc)
  const withSignal = { ...options, signal }
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, withSignal)
    : await dialog.showMessageBox(withSignal)
  if (signal.aborted) throw new CeremonyError('AbortError', 'The operation was aborted.')
  return response
}

/** Touch ID, or — on a Mac without it — a confirmation that proves only the
 *  user's presence. Resolves whether the user was verified (the UV flag). */
async function confirmUser(
  ctx: Context,
  rpId: string,
  reason: string,
  userVerification: unknown,
  confirm: MessageBoxOptions,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) throw new CeremonyError('AbortError', 'The operation was aborted.')
  if (systemPreferences.canPromptTouchID()) {
    try {
      // macOS renders this as "Newbro is trying to <reason>."
      await systemPreferences.promptTouchID(reason)
    } catch (err) {
      log.info('webauthn: Touch ID declined', String(err))
      throw new CeremonyError('NotAllowedError', NOT_ALLOWED)
    }
    if (signal.aborted) throw new CeremonyError('AbortError', 'The operation was aborted.')
    return true
  }
  if (userVerification === 'required') {
    await ask(ctx, {
      type: 'info',
      message: 'Touch ID isn\'t available',
      detail: `${rpId} asks for Touch ID to use a passkey, and Touch ID can't be used right now.`,
      buttons: ['OK'],
    }, signal)
    throw new CeremonyError('NotAllowedError', NOT_ALLOWED)
  }
  if (await ask(ctx, confirm, signal) !== 0) throw new CeremonyError('NotAllowedError', NOT_ALLOWED)
  return false
}

function accountLabel(passkey: PasskeyInfo): string {
  return passkey.userName || passkey.userDisplayName || 'Passkey'
}

// ── WebAuthn structures ──

function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: Buffer, ctx: Context): Buffer {
  // Member order as the spec serializes it; some servers compare strictly.
  return Buffer.from(JSON.stringify({
    type,
    challenge: challenge.toString('base64url'),
    origin: ctx.origin,
    crossOrigin: false,
  }))
}

function authenticatorData(rpId: string, flags: number, attestedCredential?: Buffer): Buffer {
  // rpIdHash (32) | flags (1) | signCount (4, always 0) | attested credential data
  const head = Buffer.alloc(37)
  sha256(rpId).copy(head, 0)
  head[32] = flags
  return attestedCredential ? Buffer.concat([head, attestedCredential]) : head
}

async function makeCredential(ctx: Context, req: CreateRequest, signal: AbortSignal) {
  const challenge = bytes(req.challenge, 'challenge')
  const rpId = rpIdFor(req.rp?.id, ctx.host)
  const userId = bytes(req.user?.id, 'user.id')
  if (userId.length < 1 || userId.length > 64) throw new CeremonyError('TypeError', 'user.id must be between 1 and 64 bytes.')
  const params = Array.isArray(req.pubKeyCredParams) ? req.pubKeyCredParams : []
  const es256 = params.some((p) => (p as { type?: unknown })?.type === 'public-key' && (p as { alg?: unknown }).alg === COSE_ES256)
  if (params.length > 0 && !es256) {
    throw new CeremonyError('NotSupportedError', 'None of the requested algorithms is supported (Newbro passkeys use ES256).')
  }
  const userName = text(req.user?.name)
  const userDisplayName = text(req.user?.displayName)
  const label = (userName || userDisplayName || 'your account').slice(0, 64)

  const excluded = new Set(descriptors(req.excludeCredentials).map((d) => d.id))
  if (passkeysForRp(ctx.partition, rpId).some((p) => excluded.has(p.id))) {
    await ask(ctx, {
      type: 'info',
      message: `You already have a passkey for ${rpId} in Newbro`,
      detail: 'Use it to sign in.',
      buttons: ['OK'],
    }, signal)
    throw new CeremonyError('InvalidStateError', 'The authenticator already holds one of the excluded credentials.')
  }

  const verified = await confirmUser(ctx, rpId, `save a passkey for ${label} on ${rpId}`, req.userVerification, {
    type: 'question',
    message: `Save a passkey for ${label} on ${rpId}?`,
    detail: 'Touch ID isn\'t available, so Newbro asks for this confirmation instead.',
    buttons: ['Save Passkey', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  }, signal)

  const key = await createPasskey({
    partition: ctx.partition,
    rpId,
    userId: userId.toString('base64url'),
    userName,
    userDisplayName,
  })
  const coseKey = cbor(new Map<CborValue, CborValue>([[1, 2], [3, COSE_ES256], [-1, 1], [-2, key.x], [-3, key.y]]))
  const idLength = Buffer.alloc(2)
  idLength.writeUInt16BE(key.id.length)
  const authData = authenticatorData(
    rpId,
    FLAG_UP | (verified ? FLAG_UV : 0) | FLAG_AT,
    Buffer.concat([AAGUID, idLength, key.id, coseKey]),
  )
  const attestationObject = cbor(new Map<CborValue, CborValue>([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]))
  log.info('webauthn: passkey created', { rpId })
  return {
    ok: true as const,
    id: key.id.toString('base64url'),
    clientDataJSON: clientDataJSON('webauthn.create', challenge, ctx).toString('base64url'),
    attestationObject: attestationObject.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    publicKey: key.spki.toString('base64url'),
    publicKeyAlgorithm: COSE_ES256,
    transports: ['internal'],
    extensions: req.credProps === true ? { credProps: { rk: true } } : {},
  }
}

async function getAssertion(ctx: Context, req: GetRequest, signal: AbortSignal) {
  const challenge = bytes(req.challenge, 'challenge')
  const rpId = rpIdFor(req.rpId, ctx.host)
  const allowed = descriptors(req.allowCredentials)
  const saved = passkeysForRp(ctx.partition, rpId)
  const candidates = allowed.length > 0 ? saved.filter((p) => allowed.some((d) => d.id === p.id)) : saved

  if (candidates.length === 0) {
    // Every allowed credential is explicitly a security key: let Chromium try.
    const securityKeysOnly = allowed.length > 0 && allowed.every((d) =>
      d.transports && d.transports.length > 0 && !d.transports.some((t) => t === 'internal' || t === 'hybrid'))
    if (securityKeysOnly) throw new NativeFallback()
    log.info('webauthn: no saved passkey', { rpId, allowed: allowed.length })
    await ask(ctx, {
      type: 'info',
      message: `No passkey for ${rpId} in Newbro`,
      detail: NO_PASSKEY_DETAIL,
      buttons: ['OK'],
    }, signal)
    throw new CeremonyError('NotAllowedError', NOT_ALLOWED)
  }

  let chosen = candidates[0]
  if (candidates.length > 1) {
    const shown = candidates.slice(0, 8)
    const choice = await ask(ctx, {
      type: 'question',
      message: `Sign in to ${rpId}`,
      detail: 'Choose a passkey saved in Newbro.',
      buttons: [...shown.map(accountLabel), 'Cancel'],
      defaultId: 0,
      cancelId: shown.length,
    }, signal)
    if (choice < 0 || choice >= shown.length) throw new CeremonyError('NotAllowedError', NOT_ALLOWED)
    chosen = shown[choice]
  }

  const label = accountLabel(chosen).slice(0, 64)
  const verified = await confirmUser(ctx, rpId, `sign in to ${rpId} as ${label}`, req.userVerification, {
    type: 'question',
    message: `Sign in to ${rpId} as ${label}?`,
    detail: 'Touch ID isn\'t available, so Newbro asks for this confirmation instead.',
    buttons: ['Sign In', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  }, signal)

  const authData = authenticatorData(rpId, FLAG_UP | (verified ? FLAG_UV : 0))
  const clientData = clientDataJSON('webauthn.get', challenge, ctx)
  const signature = await signWithPasskey(ctx.partition, chosen.id, Buffer.concat([authData, sha256(clientData)]))
  log.info('webauthn: signed in with passkey', { rpId })
  return {
    ok: true as const,
    id: chosen.id,
    clientDataJSON: clientData.toString('base64url'),
    authenticatorData: authData.toString('base64url'),
    signature: signature.toString('base64url'),
    userHandle: chosen.userId,
    extensions: {},
  }
}

async function runCeremony<T>(
  event: Electron.IpcMainInvokeEvent,
  requestId: unknown,
  getPartition: (ses: Session) => string,
  body: (ctx: Context, signal: AbortSignal) => Promise<T>,
): Promise<T | Failure> {
  const wc = event.sender
  if (active.has(wc.id)) return { ok: false, name: 'NotAllowedError', message: 'A request is already pending.' }
  const entry = { requestId: String(requestId ?? ''), controller: new AbortController() }
  active.set(wc.id, entry)
  // A page that navigates away is no longer waiting: close any open dialog.
  const onNavigate = (): void => entry.controller.abort()
  wc.on('did-navigate', onNavigate)
  try {
    return await body(requestContext(event, getPartition), entry.controller.signal)
  } catch (err) {
    if (err instanceof NativeFallback) return { ok: false, native: true }
    if (err instanceof CeremonyError) return { ok: false, name: err.domName, message: err.message }
    log.warn('webauthn: ceremony failed', String(err))
    return { ok: false, name: 'NotAllowedError', message: NOT_ALLOWED }
  } finally {
    if (active.get(wc.id) === entry) active.delete(wc.id)
    if (!wc.isDestroyed()) wc.removeListener('did-navigate', onNavigate)
  }
}

export function registerWebAuthnIpc(getPartition: (ses: Session) => string): void {
  // Settings → Passwords → Passkeys.
  ipcMain.handle('passkeys:list', (event, partition: string) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    return listPasskeys(partition)
  })
  ipcMain.handle('passkeys:delete', (event, partition: string, id: string) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    deletePasskey(partition, id)
    return listPasskeys(partition)
  })

  // Elsewhere Chromium's own WebAuthn works (Windows Hello), and the bridge
  // isn't installed.
  if (process.platform !== 'darwin') return

  ipcMain.handle('webauthn:available', () => systemPreferences.canPromptTouchID())
  ipcMain.handle('webauthn:create', (event, req: CreateRequest) =>
    runCeremony(event, req?.requestId, getPartition, (ctx, signal) => makeCredential(ctx, req ?? {}, signal)))
  ipcMain.handle('webauthn:get', (event, req: GetRequest) =>
    runCeremony(event, req?.requestId, getPartition, (ctx, signal) => getAssertion(ctx, req ?? {}, signal)))
  // The page aborted (AbortSignal or timeout): close our dialog, and keep a
  // Touch ID that lands afterwards from saving or signing anything.
  ipcMain.on('webauthn:cancel', (event, requestId: unknown) => {
    const entry = active.get(event.sender.id)
    if (entry && entry.requestId === String(requestId)) entry.controller.abort()
  })
}
