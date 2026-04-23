// Minimal ZIP reader. Handles STORED (method 0) and DEFLATE (method 8) —
// that covers every Chrome Web Store CRX we've seen. Written in-tree to
// avoid pulling a native dependency for something we do once on install.
//
// This is a forward-only central-directory parse:
//   1. Find EOCD record (signature 0x06054b50) by scanning from the end.
//   2. Walk the central directory (signature 0x02014b50) to enumerate entries.
//   3. For each entry, read its local file header (0x04034b50) to find the
//      actual data offset, then inflate or copy.
//
// DEFLATE decompression uses Node's built-in zlib.inflateRawSync.

import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, sep } from 'node:path'

const SIG_EOCD = 0x06054b50
const SIG_CDH = 0x02014b50
const SIG_LFH = 0x04034b50

interface CentralDirEntry {
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  fileName: string
}

function readEocd(buf: Buffer): { cdOffset: number; cdSize: number } {
  // Scan from the end for the EOCD signature. Max comment length is 65535,
  // so we can bound the search, but we scan the whole tail to be safe.
  const maxScan = Math.min(buf.length, 65_557)
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      const cdSize = buf.readUInt32LE(i + 12)
      const cdOffset = buf.readUInt32LE(i + 16)
      return { cdOffset, cdSize }
    }
  }
  throw new Error('ZIP: end-of-central-directory not found')
}

function readCentralDirectory(buf: Buffer, cdOffset: number, cdSize: number): CentralDirEntry[] {
  const entries: CentralDirEntry[] = []
  let p = cdOffset
  const end = cdOffset + cdSize
  while (p < end) {
    const sig = buf.readUInt32LE(p)
    if (sig !== SIG_CDH) {
      throw new Error(`ZIP: expected central-dir signature at ${p}, got 0x${sig.toString(16)}`)
    }
    const compressionMethod = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const uncompressedSize = buf.readUInt32LE(p + 24)
    const fileNameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localHeaderOffset = buf.readUInt32LE(p + 42)
    const fileName = buf.toString('utf8', p + 46, p + 46 + fileNameLen)
    entries.push({
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      fileName,
    })
    p += 46 + fileNameLen + extraLen + commentLen
  }
  return entries
}

function readEntryData(buf: Buffer, entry: CentralDirEntry): Buffer {
  const p = entry.localHeaderOffset
  const sig = buf.readUInt32LE(p)
  if (sig !== SIG_LFH) {
    throw new Error(`ZIP: bad local-file-header signature 0x${sig.toString(16)} at ${p}`)
  }
  const fileNameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + fileNameLen + extraLen
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.compressionMethod === 0) return Buffer.from(raw)
  if (entry.compressionMethod === 8) return inflateRawSync(raw)
  throw new Error(`ZIP: unsupported compression method ${entry.compressionMethod} for ${entry.fileName}`)
}

/** Block archive entries that would escape the destination when joined
 *  with `destDir`. Catches both absolute paths (starting with / or drive
 *  letter) and `..` segments. */
function isSafeRelPath(name: string, destDir: string): boolean {
  if (name.includes('\0')) return false
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:[\\/]/.test(normalized)) return false
  const joined = resolvePath(destDir, normalized)
  const base = resolvePath(destDir) + sep
  return joined === resolvePath(destDir) || joined.startsWith(base)
}

export function unzipTo(buf: Buffer, destDir: string): void {
  mkdirSync(destDir, { recursive: true })
  const { cdOffset, cdSize } = readEocd(buf)
  const entries = readCentralDirectory(buf, cdOffset, cdSize)
  for (const entry of entries) {
    // Directory entries end with '/' — just ensure the dir exists.
    if (entry.fileName.endsWith('/')) {
      if (!isSafeRelPath(entry.fileName, destDir)) {
        throw new Error(`ZIP: unsafe directory name ${entry.fileName}`)
      }
      mkdirSync(join(destDir, entry.fileName), { recursive: true })
      continue
    }
    if (!isSafeRelPath(entry.fileName, destDir)) {
      throw new Error(`ZIP: unsafe path ${entry.fileName}`)
    }
    const data = readEntryData(buf, entry)
    const outPath = join(destDir, entry.fileName)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, data)
  }
}
