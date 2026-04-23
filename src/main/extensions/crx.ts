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
// peel off the prefix and hand the ZIP bytes to the extractor.

const MAGIC = 0x34326143 // "Cr24" as uint32 LE

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
