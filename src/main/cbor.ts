// CBOR (RFC 8949), the subset WebAuthn and CTAP2 use: integers, byte and text
// strings, arrays, maps, booleans and null. Maps are written in insertion
// order, so callers insert keys in CTAP2 canonical order (integers ascending,
// then shorter text keys first).

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Buffer
  | CborValue[]
  | Map<CborValue, CborValue>

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length])
  if (length < 0x10000) {
    const out = Buffer.alloc(3)
    out[0] = (major << 5) | 25
    out.writeUInt16BE(length, 1)
    return out
  }
  if (length < 0x100000000) {
    const out = Buffer.alloc(5)
    out[0] = (major << 5) | 26
    out.writeUInt32BE(length, 1)
    return out
  }
  const out = Buffer.alloc(9)
  out[0] = (major << 5) | 27
  out.writeBigUInt64BE(BigInt(length), 1)
  return out
}

export function encodeCbor(value: CborValue): Buffer {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`CBOR: ${value} is not an integer`)
    return value >= 0 ? head(0, value) : head(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4])
  if (value === null) return Buffer.from([0xf6])
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)])
  const parts = [head(5, value.size)]
  for (const [key, item] of value) parts.push(encodeCbor(key), encodeCbor(item))
  return Buffer.concat(parts)
}

class Reader {
  pos = 0
  constructor(readonly buf: Buffer) {}

  take(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('CBOR: truncated')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  length(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.take(1)[0]
    if (info === 25) return this.take(2).readUInt16BE(0)
    if (info === 26) return this.take(4).readUInt32BE(0)
    if (info === 27) {
      const big = this.take(8).readBigUInt64BE(0)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: integer too large')
      return Number(big)
    }
    throw new Error(`CBOR: unsupported length encoding ${info}`)
  }

  value(depth = 0): CborValue {
    if (depth > 16) throw new Error('CBOR: nested too deeply')
    const initial = this.take(1)[0]
    const major = initial >> 5
    const info = initial & 31
    switch (major) {
      case 0: return this.length(info)
      case 1: return -1 - this.length(info)
      case 2: return Buffer.from(this.take(this.length(info)))
      case 3: return this.take(this.length(info)).toString('utf8')
      case 4: {
        const count = this.length(info)
        const out: CborValue[] = []
        for (let i = 0; i < count; i++) out.push(this.value(depth + 1))
        return out
      }
      case 5: {
        const count = this.length(info)
        const out = new Map<CborValue, CborValue>()
        for (let i = 0; i < count; i++) {
          const key = this.value(depth + 1)
          out.set(key, this.value(depth + 1))
        }
        return out
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22 || info === 23) return null
        throw new Error(`CBOR: unsupported simple value ${info}`)
      default:
        throw new Error(`CBOR: unsupported major type ${major}`)
    }
  }
}

/** Decodes one CBOR item. With `exact`, trailing bytes are an error. */
export function decodeCbor(buf: Buffer, exact = true): CborValue {
  const reader = new Reader(buf)
  const value = reader.value()
  if (exact && reader.pos !== buf.length) throw new Error('CBOR: trailing bytes')
  return value
}

/** Map lookup that tolerates a non-map. */
export function cborGet(map: CborValue | undefined, key: number | string): CborValue | undefined {
  return map instanceof Map ? map.get(key) : undefined
}
