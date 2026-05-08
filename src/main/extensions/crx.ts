// Chrome Web Store CRX parsing.
//
// A CRX file starts with the magic "Cr24" followed by a version. We support
// CRX3 (version 3), which the Web Store serves today; CRX2 is still handled
// as a fallback because some enterprise mirrors continue to emit it.
//
// Layout:
//   CRX3: magic (4) | version=3 (4) | headerLen (4) | header (headerLen) | ZIP
//   CRX2: magic (4) | version=2 (4) | pubKeyLen (4) | sigLen (4) | key | sig | ZIP
//
// We don't verify the signature here — Electron's session.loadExtension()
// accepts an unpacked directory, not the signed CRX, so our only job is to
// peel off the prefix and hand the ZIP bytes to the extractor. We DO need
// the public key though: Electron derives an extension's id from the
// manifest's `key` field, falling back to a hash of the on-disk path when
// `key` is absent. That fallback produces an id that doesn't match the
// chrome-extension://<original-id>/… URLs the rest of the world (and the
// extension itself) expects, breaking action popups and content-script
// targeting. extractCrxPublicKey gives us the bytes to plant in the
// manifest so Electron arrives at the same id Chrome Web Store assigned.
//
// IMPORTANT: a Chrome Web Store CRX3 typically contains TWO RSA proofs in
// `sha256_with_rsa[]` — the publisher's signing key (whose public-key hash
// IS the extension id) and Google's CWS enrollment / verification key. The
// publisher's key is NOT guaranteed to come first; in practice the CWS
// flavour we see today emits Google's enrollment key as the first proof.
// Picking the first one therefore makes every extension we install collide
// on Google's id. We must pass the expected id and pick the proof whose
// SHA-256 hash matches.

import { createHash } from 'node:crypto'

const MAGIC = 0x34327243 // "Cr24" as uint32 LE (bytes: 0x43 'C', 0x72 'r', 0x32 '2', 0x34 '4')

export function parseCrx(buf: Buffer): Buffer {
  if (buf.length < 16) throw new Error('CRX: file is too short')
  const magic = buf.readUInt32LE(0)
  if (magic !== MAGIC) {
    // Some CDNs hand back an un-prefixed ZIP in rare cases. Detect by the
    // ZIP local-file-header signature and pass through.
    if (buf.readUInt32LE(0) === 0x04034b50) return buf
    throw new Error(`CRX: bad magic 0x${magic.toString(16)} — expected Cr24`)
  }
  const version = buf.readUInt32LE(4)
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8)
    const zipOffset = 12 + headerLen
    if (zipOffset >= buf.length) throw new Error('CRX3: header length overruns file')
    return buf.subarray(zipOffset)
  }
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8)
    const sigLen = buf.readUInt32LE(12)
    const zipOffset = 16 + pubKeyLen + sigLen
    if (zipOffset >= buf.length) throw new Error('CRX2: header length overruns file')
    return buf.subarray(zipOffset)
  }
  throw new Error(`CRX: unsupported version ${version}`)
}

/** SHA-256(public_key) → 32-char Chrome extension id. Each hex digit
 *  maps onto the alphabet a–p (0→a, 1→b, … 9→j, a→k, b→l, … f→p),
 *  taking the first 32 chars of the hex digest. This is the canonical
 *  algorithm Chromium uses; reproducing it lets us identify which proof
 *  inside a CRX3 belongs to the publisher and which is Google's
 *  enrollment key. */
export function deriveExtensionIdFromPublicKey(pubKey: Buffer): string {
  const hex = createHash('sha256').update(pubKey).digest('hex')
  let id = ''
  for (let i = 0; i < 32; i++) {
    const c = hex.charCodeAt(i)
    let v: number
    if (c >= 48 && c <= 57) v = c - 48           // '0'-'9'
    else if (c >= 97 && c <= 102) v = c - 87     // 'a'-'f'
    else if (c >= 65 && c <= 70) v = c - 55      // 'A'-'F'
    else return ''
    id += String.fromCharCode(97 + v)            // 'a' + v
  }
  return id
}

/** Extract the publisher's public key from a CRX file. Pass `expectedId`
 *  when available — the value will be used to pick the right proof out
 *  of a CRX3 file that contains multiple RSA proofs (publisher's +
 *  Google's enrollment). When `expectedId` isn't provided we return the
 *  first key, which still matches CRX2 (single key) and offline / dev
 *  builds where there's only one proof in the header.
 *
 *  Returns the raw DER-encoded SubjectPublicKeyInfo bytes (suitable for
 *  base64-encoding into manifest.json's `key` field), or null if the file
 *  has no parseable key.
 *
 *  CRX3 stores the keys in a protobuf header (`crx_file.CrxFileHeader`):
 *
 *      message CrxFileHeader {
 *        repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *        repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
 *        optional bytes signed_header_data = 10000;
 *      }
 *      message AsymmetricKeyProof {
 *        optional bytes public_key = 1;
 *        optional bytes signature = 2;
 *      }
 *
 *  We walk the protobuf manually rather than pulling in a runtime — this
 *  is the only protobuf in the codebase, and the schema is fixed. */
export function extractCrxPublicKey(buf: Buffer, expectedId?: string): Buffer | null {
  if (buf.length < 12) return null
  if (buf.readUInt32LE(0) !== MAGIC) return null
  const version = buf.readUInt32LE(4)

  if (version === 2) {
    // CRX2 only carries a single key — no ambiguity.
    const pubKeyLen = buf.readUInt32LE(8)
    if (16 + pubKeyLen > buf.length) return null
    return Buffer.from(buf.subarray(16, 16 + pubKeyLen))
  }

  if (version !== 3) return null
  const headerLen = buf.readUInt32LE(8)
  if (12 + headerLen > buf.length) return null
  const header = buf.subarray(12, 12 + headerLen)
  const allKeys = findAllPublicKeys(header)
  if (allKeys.length === 0) return null
  if (!expectedId) return allKeys[0]
  for (const key of allKeys) {
    if (deriveExtensionIdFromPublicKey(key) === expectedId.toLowerCase()) {
      return key
    }
  }
  // No proof matched the expected id — fall back to the first proof and
  // let the caller log a warning. Returning null here would cause us to
  // skip the manifest `key` patch entirely, which means Electron would
  // hash the on-disk path and we'd end up with a different ad-hoc id;
  // returning the first proof at least preserves prior behaviour for the
  // no-expectedId code path.
  return null
}

// ── Minimal protobuf walker ─────────────────────────────────────────────

interface Varint { value: number; next: number }

function readVarint(buf: Buffer, offset: number): Varint | null {
  let value = 0
  let shift = 0
  let i = offset
  while (i < buf.length) {
    const b = buf[i]
    value |= (b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) return { value, next: i }
    shift += 7
    // Bail past 35 bits — we never care about uint64 fields in this header
    // and pretending we do would invite overflow.
    if (shift > 35) return null
  }
  return null
}

/** Walk the CrxFileHeader and collect every public_key from each
 *  AsymmetricKeyProof under sha256_with_rsa (field 2) and
 *  sha256_with_ecdsa (field 3). Order is preserved so callers that
 *  don't have an `expectedId` can still pick the first proof. */
function findAllPublicKeys(buf: Buffer): Buffer[] {
  const out: Buffer[] = []
  let i = 0
  while (i < buf.length) {
    const tag = readVarint(buf, i); if (!tag) return out
    i = tag.next
    const fieldNum = tag.value >>> 3
    const wireType = tag.value & 0x7
    if (wireType === 2) {
      const len = readVarint(buf, i); if (!len) return out
      i = len.next
      if (i + len.value > buf.length) return out
      const fieldBytes = buf.subarray(i, i + len.value)
      i += len.value
      if (fieldNum === 2 || fieldNum === 3) {
        const pk = findInnerPublicKey(fieldBytes)
        if (pk) out.push(pk)
      }
      // For field 10000 (signed_header_data) and unrecognized fields we
      // just skip the bytes.
    } else if (wireType === 0) {
      const v = readVarint(buf, i); if (!v) return out
      i = v.next
    } else if (wireType === 1) {
      i += 8
    } else if (wireType === 5) {
      i += 4
    } else {
      // Wire types 3/4 (deprecated start/end group) shouldn't appear in
      // CrxFileHeader. If they do, give up on the rest rather than guess.
      return out
    }
  }
  return out
}

/** Inside an AsymmetricKeyProof, return the bytes of field 1 (public_key). */
function findInnerPublicKey(buf: Buffer): Buffer | null {
  let i = 0
  while (i < buf.length) {
    const tag = readVarint(buf, i); if (!tag) return null
    i = tag.next
    const fieldNum = tag.value >>> 3
    const wireType = tag.value & 0x7
    if (wireType === 2) {
      const len = readVarint(buf, i); if (!len) return null
      i = len.next
      if (i + len.value > buf.length) return null
      if (fieldNum === 1) return Buffer.from(buf.subarray(i, i + len.value))
      i += len.value
    } else if (wireType === 0) {
      const v = readVarint(buf, i); if (!v) return null
      i = v.next
    } else if (wireType === 1) {
      i += 8
    } else if (wireType === 5) {
      i += 4
    } else {
      return null
    }
  }
  return null
}
