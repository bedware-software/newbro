// Browser-form password vault.
//
// This is deliberately separate from credentials-store.ts: that store answers
// HTTP Basic/Digest/NTLM/Negotiate challenges, while this one holds credentials
// entered into ordinary HTML forms. Passwords never appear in list APIs and are
// never registered as a Cloud Sync category.

import Store from 'electron-store'
import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { log } from './log'

interface StoredPasswordEntry {
  id: string
  partition: string
  origin: string
  name: string
  username: string
  passwordEnc: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PasswordEntryInfo {
  id: string
  partition: string
  origin: string
  name: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export interface PasswordLookupEntry {
  id: string
  username: string
  password: string
}

export interface PasswordImportResult {
  imported: number
  updated: number
  skipped: number
  invalid: number
}

const store = new Store<{ entries: Record<string, StoredPasswordEntry> }>({
  name: 'newbro-passwords',
  defaults: { entries: {} },
})

const MAX_IMPORT_ROWS = 10_000
const MAX_FIELD_LENGTH = 16_384

// Newer Electron releases expose non-blocking safeStorage methods. Electron
// 41's type surface does not declare them yet, so feature-detect and retain a
// synchronous fallback for the currently pinned runtime.
const asyncSafeStorage = safeStorage as typeof safeStorage & {
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  encryptStringAsync?: (value: string) => Promise<Buffer>
  decryptStringAsync?: (value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>
}

function normalizePartition(partition: string): string {
  const value = String(partition || '').trim()
  if (!/^persist:profile-[A-Za-z0-9-]+$/.test(value)) {
    throw new Error('A valid Newbro profile is required.')
  }
  return value
}

export function normalizePasswordOrigin(raw: string): string {
  let value = String(raw || '').trim()
  if (!value) throw new Error('Enter a website address.')
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only HTTP and HTTPS websites are supported.')
  }
  if (!url.hostname) throw new Error('Enter a valid website address.')
  return url.origin
}

function publicInfo(entry: StoredPasswordEntry): PasswordEntryInfo {
  const { id, partition, origin, name, username, createdAt, updatedAt, lastUsedAt } = entry
  return { id, partition, origin, name, username, createdAt, updatedAt, lastUsedAt }
}

async function encryptionAvailable(): Promise<boolean> {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    return false
  }
  if (typeof asyncSafeStorage.isAsyncEncryptionAvailable === 'function') {
    return asyncSafeStorage.isAsyncEncryptionAvailable()
  }
  return safeStorage.isEncryptionAvailable()
}

async function encryptSecret(value: string): Promise<string> {
  if (!(await encryptionAvailable())) {
    throw new Error('The operating system password vault is unavailable, so Newbro cannot save passwords safely.')
  }
  const encrypted = typeof asyncSafeStorage.encryptStringAsync === 'function'
    ? await asyncSafeStorage.encryptStringAsync(value)
    : safeStorage.encryptString(value)
  return encrypted.toString('base64')
}

async function decryptSecret(value: string): Promise<string> {
  if (!(await encryptionAvailable())) throw new Error('The operating system password vault is unavailable.')
  const encrypted = Buffer.from(value, 'base64')
  if (typeof asyncSafeStorage.decryptStringAsync === 'function') {
    const result = await asyncSafeStorage.decryptStringAsync(encrypted)
    return result.result
  }
  return safeStorage.decryptString(encrypted)
}

function findDuplicate(
  entries: Record<string, StoredPasswordEntry>,
  partition: string,
  origin: string,
  username: string,
  excludeId?: string,
): StoredPasswordEntry | undefined {
  return Object.values(entries).find((entry) =>
    entry.id !== excludeId
    && entry.partition === partition
    && entry.origin === origin
    && entry.username === username,
  )
}

export function listPasswordEntries(partition?: string): PasswordEntryInfo[] {
  const normalized = partition ? normalizePartition(partition) : null
  return Object.values(store.get('entries'))
    .filter((entry) => !normalized || entry.partition === normalized)
    .map(publicInfo)
    .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
}

export async function lookupPasswords(partition: string, origin: string): Promise<PasswordLookupEntry[]> {
  const normalizedPartition = normalizePartition(partition)
  const normalizedOrigin = normalizePasswordOrigin(origin)
  const matches = Object.values(store.get('entries'))
    .filter((entry) => entry.partition === normalizedPartition && entry.origin === normalizedOrigin)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt)
    .slice(0, 20)

  const out: PasswordLookupEntry[] = []
  for (const entry of matches) {
    try {
      out.push({ id: entry.id, username: entry.username, password: await decryptSecret(entry.passwordEnc) })
    } catch (err) {
      log.warn('passwords: failed to decrypt entry', { id: entry.id, err: String(err) })
    }
  }
  return out
}

export async function upsertPassword(input: {
  id?: string
  partition: string
  origin: string
  name?: string
  username: string
  password?: string
}): Promise<{ entry: PasswordEntryInfo; created: boolean }> {
  const partition = normalizePartition(input.partition)
  const origin = normalizePasswordOrigin(input.origin)
  const username = String(input.username || '').trim().slice(0, MAX_FIELD_LENGTH)
  const name = String(input.name || '').trim().slice(0, 512)
  const password = input.password === undefined ? undefined : String(input.password).slice(0, MAX_FIELD_LENGTH)
  if (!username) throw new Error('Enter a username or email address.')

  const entries = store.get('entries')
  const existing = input.id ? entries[input.id] : findDuplicate(entries, partition, origin, username)
  if (input.id && (!existing || existing.partition !== partition)) throw new Error('Password entry not found.')
  const duplicate = findDuplicate(entries, partition, origin, username, existing?.id)
  if (duplicate) throw new Error('A password for this website and username already exists.')
  if (!existing && password === undefined) throw new Error('Enter a password.')

  const now = Date.now()
  const next: StoredPasswordEntry = existing
    ? {
        ...existing,
        origin,
        name: name || existing.name,
        username,
        passwordEnc: password === undefined ? existing.passwordEnc : await encryptSecret(password),
        updatedAt: now,
      }
    : {
        id: randomUUID(),
        partition,
        origin,
        name,
        username,
        passwordEnc: await encryptSecret(password ?? ''),
        createdAt: now,
        updatedAt: now,
        lastUsedAt: 0,
      }

  entries[next.id] = next
  store.set('entries', entries)
  return { entry: publicInfo(next), created: !existing }
}

export function deletePasswordEntry(partition: string, id: string): void {
  const normalizedPartition = normalizePartition(partition)
  const entries = store.get('entries')
  const existing = entries[id]
  if (!existing || existing.partition !== normalizedPartition) return
  delete entries[id]
  store.set('entries', entries)
}

export function clearPasswordEntries(partition: string): void {
  const normalizedPartition = normalizePartition(partition)
  const entries = store.get('entries')
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.partition === normalizedPartition) delete entries[id]
  }
  store.set('entries', entries)
}

export function markPasswordUsed(partition: string, id: string): void {
  const normalizedPartition = normalizePartition(partition)
  const entries = store.get('entries')
  const existing = entries[id]
  if (!existing || existing.partition !== normalizedPartition) return
  entries[id] = { ...existing, lastUsedAt: Date.now() }
  store.set('entries', entries)
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field.length === 0) quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      if (row.some((value) => value.length > 0)) rows.push(row)
      row = []
      if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error(`The CSV contains more than ${MAX_IMPORT_ROWS} passwords.`)
    } else {
      field += char
    }
  }
  row.push(field)
  if (row.some((value) => value.length > 0)) rows.push(row)
  return rows
}

function findHeader(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header.trim().toLowerCase().replace(/^\uFEFF/, '')))
}

export async function importPasswordsCsv(partition: string, text: string): Promise<PasswordImportResult> {
  const normalizedPartition = normalizePartition(partition)
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('The CSV does not contain any password rows.')
  const headers = rows[0]
  const urlIndex = findHeader(headers, ['url', 'website', 'origin', 'login_uri'])
  const usernameIndex = findHeader(headers, ['username', 'user', 'login_username'])
  const passwordIndex = findHeader(headers, ['password', 'login_password'])
  const nameIndex = findHeader(headers, ['name', 'title'])
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) {
    throw new Error('Unsupported CSV. Expected URL, username, and password columns from Edge or Chrome.')
  }

  const result: PasswordImportResult = { imported: 0, updated: 0, skipped: 0, invalid: 0 }
  for (const row of rows.slice(1, MAX_IMPORT_ROWS + 1)) {
    const rawUrl = String(row[urlIndex] ?? '').trim()
    const username = String(row[usernameIndex] ?? '').trim().slice(0, MAX_FIELD_LENGTH)
    const password = String(row[passwordIndex] ?? '').slice(0, MAX_FIELD_LENGTH)
    const name = nameIndex >= 0 ? String(row[nameIndex] ?? '').trim().slice(0, 512) : ''
    if (!rawUrl || !username || !password) {
      result.skipped += 1
      continue
    }
    try {
      const origin = normalizePasswordOrigin(rawUrl)
      const entries = store.get('entries')
      const duplicate = findDuplicate(entries, normalizedPartition, origin, username)
      await upsertPassword({ partition: normalizedPartition, origin, name, username, password })
      if (duplicate) result.updated += 1
      else result.imported += 1
    } catch (err) {
      log.warn('passwords: skipped invalid CSV row', { row: result.imported + result.updated + result.skipped + result.invalid + 1, err: String(err) })
      result.invalid += 1
    }
  }
  return result
}
