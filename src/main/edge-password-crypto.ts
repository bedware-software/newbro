import { createDecipheriv } from 'crypto'

/** Decrypt one Chromium macOS v10 value with an already-unlocked key. */
export function decryptMacEdgePassword(blob: Uint8Array, key: Buffer): string | null {
  const value = Buffer.from(blob)
  if (value.length <= 3 || value.subarray(0, 3).toString('ascii') !== 'v10') return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Decrypt one Chromium Windows v10/v11 value with an unwrapped master key. */
export function decryptWindowsEdgePassword(blob: Uint8Array, key: Buffer): string | null {
  const value = Buffer.from(blob)
  const prefix = value.subarray(0, 3).toString('ascii')
  if ((prefix !== 'v10' && prefix !== 'v11') || value.length < 3 + 12 + 16 + 1) return null
  try {
    const nonce = value.subarray(3, 15)
    const tag = value.subarray(value.length - 16)
    const ciphertext = value.subarray(15, value.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
