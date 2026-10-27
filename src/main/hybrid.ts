// Signing in with a passkey from a phone: the hybrid transport (caBLE v2,
// CTAP 2.2 "hybrid"), client side, as Chromium's device/fido/cable does it.
//
// macOS hands iCloud Keychain passkeys only to browsers Apple entitles, but an
// iPhone serves those same passkeys to any client that speaks this protocol:
//
//   1. Newbro shows a QR code — FIDO:/ plus digits encoding CBOR with a fresh
//      identity public key and secret. The iPhone's Camera scans it.
//   2. The phone connects to its tunnel server (Apple's is cable.auth.com) and
//      broadcasts a Bluetooth LE advert, encrypted with a key derived from the
//      QR secret, that names the tunnel. Bluetooth is the proximity check: a
//      remote attacker who sees the QR code can't receive the advert. Node has
//      no Bluetooth, so the newbro-hybrid helper (native/) scans for it.
//   3. Newbro joins the tunnel over WebSocket, runs a Noise KNpsk0 handshake
//      keyed by the QR identity and a PSK derived from the advert, and sends a
//      CTAP2 getAssertion. The phone asks for Face ID and returns the assertion.

import { BrowserWindow } from 'electron'
import { execFile, spawn } from 'child_process'
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto'
import type { ECDH } from 'crypto'
import { join, sep } from 'path'
import { createInterface } from 'readline'
import { cborGet, decodeCbor, encodeCbor } from './cbor'
import type { CborValue } from './cbor'
import { log } from './log'

export type HybridFailure = 'cancelled' | 'denied' | 'no-credentials' | 'ended' | 'failed'

export class HybridError extends Error {
  constructor(readonly reason: HybridFailure, message: string) {
    super(message)
  }
}

export interface PhoneAssertion {
  credentialId: Buffer
  authenticatorData: Buffer
  signature: Buffer
  userHandle: Buffer | null
}

// ── Key derivation ──

const DERIVED_EID_KEY = 1
const DERIVED_TUNNEL_ID = 2
const DERIVED_PSK = 3

/** HKDF-SHA256 (RFC 5869). */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt.length > 0 ? salt : Buffer.alloc(32)).update(ikm).digest()
  const blocks: Buffer[] = []
  let previous = Buffer.alloc(0)
  for (let i = 1; blocks.length * 32 < length; i++) {
    previous = createHmac('sha256', prk).update(Buffer.concat([previous, info, Buffer.from([i])])).digest()
    blocks.push(previous)
  }
  return Buffer.concat(blocks).subarray(0, length)
}

function derive(secret: Buffer, nonce: Buffer, type: number, length: number): Buffer {
  const info = Buffer.alloc(4)
  info.writeUInt32LE(type)
  return hkdf(secret, nonce, info, length)
}

// ── QR code ──

/** 7-byte little-endian chunks as zero-padded decimal: digits pack far
 *  denser into a QR code than base64. */
export function bytesToDigits(bytes: Buffer): string {
  const widths = [0, 3, 5, 8, 10, 13, 15, 17]
  let out = ''
  for (let i = 0; i < bytes.length; i += 7) {
    const chunk = bytes.subarray(i, i + 7)
    let value = 0n
    for (let j = chunk.length - 1; j >= 0; j--) value = (value << 8n) | BigInt(chunk[j])
    out += value.toString().padStart(widths[chunk.length], '0')
  }
  return out
}

function qrUrl(identity: ECDH, secret: Buffer): string {
  const contents = new Map<CborValue, CborValue>([
    [0, identity.getPublicKey(null, 'compressed')],
    [1, secret],
    // Tunnel server domains this client knows by number: cable.ua5v.com, cable.auth.com.
    [2, 2],
    [3, Math.floor(Date.now() / 1000)],
    // No linking: each sign-in scans a fresh code, as Chromium does for WebAuthn.
    [4, false],
    [5, 'ga'],
  ])
  return `FIDO:/${bytesToDigits(encodeCbor(contents))}`
}

// ── Bluetooth advert ──

/** Tunnel server domain for an advert's 16-bit domain ID: 0 and 1 are
 *  assigned, 256 and up are hashed. */
export function tunnelDomain(id: number): string | null {
  const assigned = ['cable.ua5v.com', 'cable.auth.com']
  if (id < 256) return assigned[id] ?? null
  const template = Buffer.alloc(31)
  template.write('caBLEv2 tunnel server domain', 0, 'ascii')
  template.writeUInt16LE(id, 28)
  let value = createHash('sha256').update(template).digest().readBigUInt64LE(0)
  const tld = ['com', 'org', 'net', 'info'][Number(value & 3n)]
  value >>= 2n
  const base32 = 'abcdefghijklmnopqrstuvwxyz234567'
  let name = 'cable.'
  while (value !== 0n) {
    name += base32[Number(value & 31n)]
    value >>= 5n
  }
  return `${name}.${tld}`
}

/** The advert is one AES-256 block (the EID) and 4 bytes of HMAC. Returns
 *  the EID when the advert was made with this QR code's key. */
function decryptAdvert(advert: Buffer, eidKey: Buffer): Buffer | null {
  if (advert.length !== 20) return null
  const tag = createHmac('sha256', eidKey.subarray(32)).update(advert.subarray(0, 16)).digest().subarray(0, 4)
  if (!timingSafeEqual(tag, advert.subarray(16))) return null
  const decipher = createDecipheriv('aes-256-ecb', eidKey.subarray(0, 32), null)
  decipher.setAutoPadding(false)
  const eid = Buffer.concat([decipher.update(advert.subarray(0, 16)), decipher.final()])
  // Reserved byte, and a domain this client can resolve.
  if (eid[0] !== 0 || tunnelDomain(eid.readUInt16LE(14)) === null) return null
  return eid
}

// ── Noise (Noise_KNpsk0_P256_AESGCM_SHA256, Chromium's variant) ──

class Noise {
  private ck: Buffer
  private h: Buffer
  private k: Buffer = Buffer.alloc(32)
  private n = 0

  constructor(protocolName: string) {
    this.ck = Buffer.alloc(32)
    this.ck.write(protocolName, 'ascii')
    this.h = Buffer.from(this.ck)
  }

  mixHash(data: Buffer): void {
    this.h = createHash('sha256').update(this.h).update(data).digest()
  }

  mixKey(ikm: Buffer): void {
    const out = hkdf(ikm, this.ck, Buffer.alloc(0), 64)
    this.ck = out.subarray(0, 32)
    this.k = out.subarray(32, 64)
    this.n = 0
  }

  mixKeyAndHash(ikm: Buffer): void {
    const out = hkdf(ikm, this.ck, Buffer.alloc(0), 96)
    this.ck = out.subarray(0, 32)
    this.mixHash(out.subarray(32, 64))
    this.k = out.subarray(64, 96)
    this.n = 0
  }

  // Chromium puts the counter in the nonce's first four bytes, big-endian.
  private nonce(): Buffer {
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(this.n++, 0)
    return nonce
  }

  encryptAndHash(plaintext: Buffer): Buffer {
    const cipher = createCipheriv('aes-256-gcm', this.k, this.nonce())
    cipher.setAAD(this.h)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Buffer): Buffer {
    if (ciphertext.length < 16) throw new Error('Noise: ciphertext too short')
    const decipher = createDecipheriv('aes-256-gcm', this.k, this.nonce())
    decipher.setAAD(this.h)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
    this.mixHash(ciphertext)
    return plaintext
  }

  trafficKeys(): [Buffer, Buffer] {
    const out = hkdf(Buffer.alloc(0), this.ck, Buffer.alloc(0), 64)
    return [out.subarray(0, 32), out.subarray(32, 64)]
  }
}

/** The tunnel's message layer: AES-256-GCM, a per-direction counter in the
 *  last four nonce bytes, plaintext zero-padded to 32-byte multiples. */
class Crypter {
  private readSeq = 0
  private writeSeq = 0

  constructor(private readonly readKey: Buffer, private readonly writeKey: Buffer) {}

  private static nonce(seq: number): Buffer {
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(seq, 8)
    return nonce
  }

  encrypt(message: Buffer): Buffer {
    const padded = Buffer.alloc((message.length + 1 + 31) & ~31)
    message.copy(padded)
    padded[padded.length - 1] = padded.length - message.length - 1
    const cipher = createCipheriv('aes-256-gcm', this.writeKey, Crypter.nonce(this.writeSeq++))
    return Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])
  }

  decrypt(ciphertext: Buffer): Buffer {
    if (ciphertext.length < 16) throw new Error('tunnel message too short')
    const decipher = createDecipheriv('aes-256-gcm', this.readKey, Crypter.nonce(this.readSeq))
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
    this.readSeq++
    const padding = padded.length > 0 ? padded[padded.length - 1] : 256
    if (padding + 1 > padded.length) throw new Error('tunnel message has invalid padding')
    return padded.subarray(0, padded.length - padding - 1)
  }
}

/** The desktop's half of the QR handshake (Chromium's HandshakeInitiator
 *  with a local identity and a PSK). */
class HandshakeInitiator {
  private readonly noise = new Noise('Noise_KNpsk0_P256_AESGCM_SHA256')
  private readonly ephemeral = createECDH('prime256v1')

  constructor(private readonly identity: ECDH, psk: Buffer) {
    this.noise.mixHash(Buffer.from([1]))
    this.noise.mixHash(identity.getPublicKey())
    this.noise.mixKeyAndHash(psk)
  }

  initialMessage(): Buffer {
    const ephemeralPublic = this.ephemeral.generateKeys()
    this.noise.mixHash(ephemeralPublic)
    this.noise.mixKey(ephemeralPublic)
    return Buffer.concat([ephemeralPublic, this.noise.encryptAndHash(Buffer.alloc(0))])
  }

  processResponse(response: Buffer): Crypter {
    if (response.length !== 65 + 16) throw new Error(`handshake response is ${response.length} bytes`)
    const peer = response.subarray(0, 65)
    const sharedEE = this.ephemeral.computeSecret(peer)
    this.noise.mixHash(peer)
    this.noise.mixKey(peer)
    this.noise.mixKey(sharedEE)
    this.noise.mixKey(this.identity.computeSecret(peer))
    if (this.noise.decryptAndHash(response.subarray(65)).length !== 0) throw new Error('handshake payload not empty')
    const [writeKey, readKey] = this.noise.trafficKeys()
    return new Crypter(readKey, writeKey)
  }
}

// ── Tunnel (WebSocket) ──

class TunnelClosed extends Error {
  constructor(readonly code: number, reason: string) {
    super(`tunnel closed (${code}${reason ? ` ${reason}` : ''})`)
  }
}

class Tunnel {
  private readonly socket: WebSocket
  private readonly inbox: Buffer[] = []
  private waiter: { resolve: (data: Buffer) => void; reject: (err: Error) => void } | null = null
  private failure: Error | null = null

  private constructor(url: string, private readonly opened: (err?: Error) => void) {
    this.socket = new WebSocket(url, 'fido.cable')
    this.socket.binaryType = 'arraybuffer'
    this.socket.onopen = () => {
      if (this.socket.protocol !== 'fido.cable') this.fail(new Error('tunnel server did not accept the fido.cable protocol'))
      else opened()
    }
    this.socket.onmessage = (event) => {
      const data = Buffer.from(event.data as ArrayBuffer)
      if (this.waiter) {
        this.waiter.resolve(data)
        this.waiter = null
      } else {
        this.inbox.push(data)
      }
    }
    this.socket.onerror = () => this.fail(new Error('tunnel connection error'))
    this.socket.onclose = (event) => this.fail(new TunnelClosed(event.code, event.reason))
  }

  static open(url: string): Promise<Tunnel> {
    return new Promise((resolve, reject) => {
      const tunnel: Tunnel = new Tunnel(url, (err) => (err ? reject(err) : resolve(tunnel)))
    })
  }

  private fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    this.opened(err)
    this.waiter?.reject(err)
    this.waiter = null
  }

  next(): Promise<Buffer> {
    const queued = this.inbox.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  send(data: Buffer): void {
    this.socket.send(new Uint8Array(data))
  }

  close(): void {
    this.failure ??= new Error('tunnel closed')
    this.socket.close()
  }
}

const MESSAGE_SHUTDOWN = 0
const MESSAGE_CTAP = 1
const MESSAGE_UPDATE = 2

/** The post-handshake message is unpadded CBOR from protocol revision 1;
 *  revision 0 padded it (two formats). Returns the map and the revision. */
function decodePostHandshake(data: Buffer): { payload: CborValue; revision: number } {
  try {
    return { payload: decodeCbor(data), revision: 1 }
  } catch {
    // Revision 0: try both padding formats, new first, as Chromium does.
  }
  if (data.length >= 2) {
    const padding = data.readUInt16LE(data.length - 2)
    if (padding + 2 <= data.length) {
      try {
        return { payload: decodeCbor(data.subarray(0, data.length - padding - 2)), revision: 0 }
      } catch {
        // Fall through to the one-byte padding format.
      }
    }
  }
  const padding = data[data.length - 1] ?? 0
  return { payload: decodeCbor(data.subarray(0, Math.max(0, data.length - padding - 1))), revision: 0 }
}

// ── The helper (Bluetooth scan, QR rendering) ──

function helperPath(): string {
  // Packed builds run it from app.asar.unpacked (build.asarUnpack).
  return join(__dirname, '../native/newbro-hybrid').replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

function renderQr(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), ['qr', text], (err, stdout, stderr) => {
      if (err) reject(new Error(`QR helper failed: ${stderr || err.message}`))
      else resolve(stdout.trim())
    })
  })
}

/** Scans Bluetooth until an advert decrypts with this QR code's key. */
function scanForAdvert(eidKey: Buffer, onState: (state: string) => void, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), ['scan'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const seen = new Set<string>()
    let stderr = ''
    let settled = false
    const finish = (err: Error | null, eid?: Buffer): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      child.stdin.end()
      child.kill()
      if (err) reject(err)
      else resolve(eid as Buffer)
    }
    const onAbort = (): void => finish(new HybridError('cancelled', 'Cancelled.'))
    signal.addEventListener('abort', onAbort)
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => finish(new Error(`Bluetooth helper failed to start: ${err.message}`)))
    child.on('exit', (code, sig) => finish(new Error(`Bluetooth helper exited (${code ?? sig}): ${stderr.trim()}`)))
    createInterface({ input: child.stdout }).on('line', (line) => {
      const [kind, value] = line.split(' ')
      if (kind === 'state') {
        onState(value)
      } else if (kind === 'advert' && /^[0-9a-f]{40}$/.test(value) && !seen.has(value)) {
        seen.add(value)
        const eid = decryptAdvert(Buffer.from(value, 'hex'), eidKey)
        if (eid) finish(null, eid)
      }
    })
  })
}

// ── The window with the QR code ──

const PHONE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Use a passkey from your iPhone</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #fff; --error: #d70015; --accent: #0071e3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #1e1e1e; --card: #2c2c2e; --error: #ff6961; --accent: #0a84ff; } }
  * { box-sizing: border-box; }
  html, body { overflow: hidden; }
  body { margin: 0; padding: 22px 26px 20px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, sans-serif; color: var(--fg); background: var(--bg); -webkit-user-select: none; cursor: default; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  p { margin: 0; color: var(--muted); }
  .qr { margin: 18px auto 16px; width: 212px; height: 212px; padding: 14px; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .qr img { width: 100%; height: 100%; image-rendering: pixelated; display: block; }
  #status { min-height: 38px; color: var(--fg); text-align: center; }
  #status.error { color: var(--error); }
  .actions { display: flex; justify-content: flex-end; margin-top: 14px; }
  button { font: inherit; padding: 4px 16px; border-radius: 6px; border: 0; background: var(--card); color: var(--fg); box-shadow: 0 0 0 0.5px rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.1); }
  button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); }
</style></head>
<body>
  <h1>Use a passkey from your iPhone</h1>
  <p id="intro"></p>
  <div class="qr"><img id="qr" alt="QR code"></div>
  <div id="status"></div>
  <div class="actions"><button id="cancel">Cancel</button></div>
  <script>
    const params = new URLSearchParams(location.hash.slice(1));
    document.getElementById('intro').textContent = 'Scan this code with your iPhone\\u2019s Camera to sign in to ' +
      params.get('rp') + ' with the passkey saved there.';
    document.getElementById('qr').src = 'data:image/png;base64,' + params.get('qr');
    window.setStatus = (text, error) => {
      const el = document.getElementById('status');
      el.textContent = text;
      el.className = error ? 'error' : '';
    };
    document.getElementById('cancel').onclick = () => window.close();
    addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
  </script>
</body></html>`

// The last attempt's window. A failed attempt leaves its reason showing; the
// next attempt replaces it — on macOS a second sheet would wait behind it.
let openPhoneWindow: PhoneWindow | null = null

class PhoneWindow {
  private readonly win: BrowserWindow
  readonly closed: Promise<void>

  constructor(parent: BrowserWindow | null, rpId: string, qrPng: string) {
    openPhoneWindow?.close()
    openPhoneWindow = this
    this.win = new BrowserWindow({
      parent: parent ?? undefined,
      modal: !!parent,
      width: 360,
      height: 450,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      title: 'Use a passkey from your iPhone',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.closed = new Promise((resolve) => this.win.once('closed', () => {
      if (openPhoneWindow === this) openPhoneWindow = null
      resolve()
    }))
    this.win.once('ready-to-show', () => this.win.show())
    // The page has no network access, scripts from elsewhere or way out.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.win.webContents.on('will-navigate', (event) => event.preventDefault())
    const hash = new URLSearchParams({ rp: rpId, qr: qrPng }).toString()
    void this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PHONE_PAGE)}#${hash}`)
  }

  status(text: string, error = false): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.executeJavaScript(`window.setStatus(${JSON.stringify(text)}, ${error})`).catch((err) => {
      log.warn('hybrid: status update failed', String(err))
    })
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close()
  }
}

// ── CTAP ──

const CTAP_GET_ASSERTION = 0x02
const CTAP2_ERR_OPERATION_DENIED = 0x27
const CTAP2_ERR_KEEPALIVE_CANCEL = 0x2d
const CTAP2_ERR_NO_CREDENTIALS = 0x2e

function getAssertionCommand(rpId: string, clientDataHash: Buffer, allowList: Buffer[], uv: boolean): Buffer {
  const params = new Map<CborValue, CborValue>([[1, rpId], [2, clientDataHash]])
  if (allowList.length > 0) {
    params.set(3, allowList.map((id) => new Map<CborValue, CborValue>([['id', id], ['type', 'public-key']])))
  }
  if (uv) params.set(5, new Map<CborValue, CborValue>([['uv', true]]))
  return Buffer.concat([Buffer.from([CTAP_GET_ASSERTION]), encodeCbor(params)])
}

function parseAssertion(response: Buffer, allowList: Buffer[]): PhoneAssertion {
  const status = response[0]
  if (status === CTAP2_ERR_NO_CREDENTIALS) throw new HybridError('no-credentials', 'Your iPhone has no passkey for this site.')
  if (status === CTAP2_ERR_OPERATION_DENIED || status === CTAP2_ERR_KEEPALIVE_CANCEL) {
    throw new HybridError('denied', 'Cancelled on your iPhone.')
  }
  if (status !== 0) throw new HybridError('failed', `Your iPhone returned error 0x${status?.toString(16)}.`)
  const body = decodeCbor(response.subarray(1))
  const credential = cborGet(body, 1)
  const credentialId = cborGet(credential, 'id') ?? (allowList.length === 1 ? allowList[0] : undefined)
  const authenticatorData = cborGet(body, 2)
  const signature = cborGet(body, 3)
  const userHandle = cborGet(cborGet(body, 4), 'id')
  if (!Buffer.isBuffer(credentialId) || !Buffer.isBuffer(authenticatorData) || !Buffer.isBuffer(signature)) {
    throw new HybridError('failed', 'Your iPhone sent an incomplete answer.')
  }
  return { credentialId, authenticatorData, signature, userHandle: Buffer.isBuffer(userHandle) ? userHandle : null }
}

/** Runs one CTAP command over the tunnel the advert names. */
async function transact(
  eid: Buffer,
  qrSecret: Buffer,
  identity: ECDH,
  buildCommand: (getInfo: CborValue) => Buffer,
  onReady: () => void,
  signal: AbortSignal,
): Promise<Buffer> {
  const domain = tunnelDomain(eid.readUInt16LE(14)) as string
  const routingId = eid.subarray(11, 14)
  const tunnelId = derive(qrSecret, Buffer.alloc(0), DERIVED_TUNNEL_ID, 16)
  const psk = derive(qrSecret, eid, DERIVED_PSK, 32)
  const url = `wss://${domain}/cable/connect/${routingId.toString('hex').toUpperCase()}/${tunnelId.toString('hex').toUpperCase()}`
  log.info('hybrid: connecting to tunnel', domain)

  const tunnel = await Tunnel.open(url)
  const onAbort = (): void => tunnel.close()
  signal.addEventListener('abort', onAbort)
  try {
    const handshake = new HandshakeInitiator(identity, psk)
    tunnel.send(handshake.initialMessage())
    let reply = await tunnel.next()
    // A tunnel server may signal the phone's arrival with a single 0 byte.
    if (reply.length === 1 && reply[0] === 0) reply = await tunnel.next()
    const crypter = handshake.processResponse(reply)

    const { payload, revision } = decodePostHandshake(crypter.decrypt(await tunnel.next()))
    const features = cborGet(payload, 3)
    if (Array.isArray(features) && !features.includes('ctap')) throw new Error('the phone does not offer CTAP')
    const getInfoBytes = cborGet(payload, 1)
    if (!Buffer.isBuffer(getInfoBytes)) throw new Error('post-handshake message has no getInfo')
    log.info('hybrid: tunnel established', { revision })
    onReady()

    const command = buildCommand(decodeCbor(getInfoBytes))
    tunnel.send(crypter.encrypt(revision >= 1 ? Buffer.concat([Buffer.from([MESSAGE_CTAP]), command]) : command))
    for (;;) {
      let data: Buffer
      try {
        data = await tunnel.next()
      } catch (err) {
        // The phone hung up without an answer: it found no passkey for the
        // site, or the user closed the sheet there.
        if (err instanceof TunnelClosed && err.code === 1000 && !signal.aborted) {
          throw new HybridError('ended', 'Your iPhone ended the sign-in without a passkey. If it found none for this site, check that the Passwords app on it has one.')
        }
        throw err
      }
      const message = crypter.decrypt(data)
      if (revision < 1) return message
      if (message[0] === MESSAGE_UPDATE) continue // linking updates: not used
      if (message[0] !== MESSAGE_CTAP) throw new Error(`unexpected tunnel message type ${message[0]}`)
      tunnel.send(crypter.encrypt(Buffer.from([MESSAGE_SHUTDOWN])))
      return message.subarray(1)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    tunnel.close()
  }
}

/** Asks a phone for an assertion: shows the QR code, waits for the phone's
 *  advert, then runs getAssertion through the tunnel. */
export async function getAssertionFromPhone(options: {
  parent: BrowserWindow | null
  rpId: string
  clientDataHash: Buffer
  allowList: Buffer[]
  userVerification: boolean
  signal: AbortSignal
}): Promise<PhoneAssertion> {
  const identity = createECDH('prime256v1')
  identity.generateKeys()
  const qrSecret = randomBytes(16)
  const eidKey = derive(qrSecret, Buffer.alloc(0), DERIVED_EID_KEY, 64)

  const window = new PhoneWindow(options.parent, options.rpId, await renderQr(qrUrl(identity, qrSecret)))
  // Closing the window (Cancel, Esc) or the page giving up ends the attempt.
  const cancel = new AbortController()
  const onPageAbort = (): void => cancel.abort()
  options.signal.addEventListener('abort', onPageAbort)
  void window.closed.then(() => cancel.abort())
  const cancelled = (): HybridError => new HybridError('cancelled', 'Cancelled.')

  window.status('Waiting for your iPhone…')
  try {
    const eid = await scanForAdvert(eidKey, (state) => {
      if (state === 'off') window.status('Turn on Bluetooth: your iPhone talks to this Mac over Bluetooth.', true)
      else if (state === 'unauthorized') {
        window.status('Allow Newbro to use Bluetooth in System Settings → Privacy & Security → Bluetooth.', true)
      } else if (state === 'unsupported') window.status('This Mac has no Bluetooth LE.', true)
      else if (state === 'on') window.status('Waiting for your iPhone…')
    }, cancel.signal)
    log.info('hybrid: phone advert received')
    window.status('Connecting to your iPhone…')

    const response = await transact(eid, qrSecret, identity, (getInfo) => {
      const uvSupported = cborGet(cborGet(getInfo, 4), 'uv') === true
      return getAssertionCommand(options.rpId, options.clientDataHash, options.allowList, options.userVerification && uvSupported)
    }, () => window.status('Continue on your iPhone.'), cancel.signal)
    if (cancel.signal.aborted) throw cancelled()
    const assertion = parseAssertion(response, options.allowList)
    log.info('hybrid: assertion received')
    window.close()
    return assertion
  } catch (err) {
    if (cancel.signal.aborted) {
      window.close()
      throw cancelled()
    }
    const error = err instanceof HybridError ? err : new HybridError('failed', String((err as Error)?.message ?? err))
    log.warn('hybrid: failed', { reason: error.reason, message: error.message })
    // Cancelled on the phone: nothing to explain. Otherwise leave the window
    // up with the reason; the page's request ends now.
    if (error.reason === 'denied') window.close()
    else window.status(error.reason === 'failed' ? `Couldn't sign in with your iPhone: ${error.message}` : error.message, true)
    throw error
  } finally {
    options.signal.removeEventListener('abort', onPageAbort)
  }
}
