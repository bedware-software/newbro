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

/** Extract the first `public_key` declared in a CRX file's signature header.
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
 *  is the only protobuf in the codebase, and the schema is fixed. CRX2
 *  is simpler: the public key is a length-prefixed blob right after the
 *  version field. */
export function extractCrxPublicKey(buf: Buffer): Buffer | null {
  if (buf.length < 12) return null
  if (buf.readUInt32LE(0) !== MAGIC) return null
  const version = buf.readUInt32LE(4)

  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8)
    if (16 + pubKeyLen > buf.length) return null
    return Buffer.from(buf.subarray(16, 16 + pubKeyLen))
  }

  if (version !== 3) return null
  const headerLen = buf.readUInt32LE(8)
  if (12 + headerLen > buf.length) return null
  const header = buf.subarray(12, 12 + headerLen)
  return findFirstPublicKey(header)
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

/** Scan the CrxFileHeader for the first AsymmetricKeyProof (field 2 RSA
 *  or field 3 ECDSA) and return its public_key (field 1). */
function findFirstPublicKey(buf: Buffer): Buffer | null {
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
      const fieldBytes = buf.subarray(i, i + len.value)
      i += len.value
      if (fieldNum === 2 || fieldNum === 3) {
        const pk = findInnerPublicKey(fieldBytes)
        if (pk) return pk
      }
      // For field 10000 (signed_header_data) and unrecognized fields we
      // just skip the bytes.
    } else if (wireType === 0) {
      const v = readVarint(buf, i); if (!v) return null
      i = v.next
    } else if (wireType === 1) {
      i += 8
    } else if (wireType === 5) {
      i += 4
    } else {
      // Wire types 3/4 (deprecated start/end group) shouldn't appear in
      // CrxFileHeader. If they do, give up rather than guess.
      return null
    }
  }
  return null
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
