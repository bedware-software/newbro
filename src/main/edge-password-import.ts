// Direct Microsoft Edge password import.
//
// Detection reads metadata only. Decryption is performed only after an
// explicit Settings action and relies on the same OS protection Edge uses:
// Keychain on macOS and CurrentUser DPAPI on Windows. No credential value is
// ever logged or returned to the renderer.

import { pbkdf2Sync } from 'crypto'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import { DatabaseSync } from 'node:sqlite'
import { listPasswordEntries, normalizePasswordOrigin, upsertPassword } from './password-store'
import { decryptMacEdgePassword, decryptWindowsEdgePassword } from './edge-password-crypto'
import { log } from './log'

const MAX_EDGE_PASSWORDS = 20_000
const MAC_EDGE_SAFE_STORAGE_SERVICE = 'Microsoft Edge Safe Storage'
const MAC_EDGE_SAFE_STORAGE_ACCOUNT = 'Microsoft Edge'

export interface EdgeProfileInfo {
  id: string
  name: string
  passwordCount: number
  appBoundPasswordCount: number
}

export interface EdgePasswordSourceInfo {
  installed: boolean
  supported: boolean
  profiles: EdgeProfileInfo[]
  passwordCount: number
  appBoundPasswordCount: number
  reason?: string
}

export interface EdgePasswordImportResult {
  imported: number
  updated: number
  skipped: number
  invalid: number
  appBound: number
  unsupported: number
  profiles: number
}

interface EdgeProfileSource extends EdgeProfileInfo {
  loginDataPath: string
}

interface EdgeLoginRow {
  origin_url: string
  username_value: string
  password_value: Uint8Array
}

interface LocalState {
  os_crypt?: { encrypted_key?: string }
  profile?: {
    info_cache?: Record<string, { name?: string }>
  }
}

function edgeUserDataRoot(): string | null {
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Microsoft Edge')
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    return localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'User Data') : null
  }
  return null
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function readLocalState(root: string): Promise<LocalState> {
  try {
    const raw = await fs.readFile(path.join(root, 'Local State'), 'utf8')
    return JSON.parse(raw) as LocalState
  } catch {
    return {}
  }
}

async function withLoginDatabase<T>(loginDataPath: string, action: (db: DatabaseSync) => T): Promise<T> {
  // Copy the database and its WAL sidecars so a running Edge process cannot
  // leave us with a locked or internally inconsistent read.
  const scratch = await fs.mkdtemp(path.join(tmpdir(), 'newbro-edge-import-'))
  const copyPath = path.join(scratch, 'Login Data')
  try {
    await fs.copyFile(loginDataPath, copyPath)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${loginDataPath}${suffix}`
      if (await pathExists(source)) await fs.copyFile(source, `${copyPath}${suffix}`)
    }
    const db = new DatabaseSync(copyPath, { readOnly: true })
    try {
      return action(db)
    } finally {
      db.close()
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
}

function loginTableColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(logins)').all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => String(row.name || '')))
}

function inspectLogins(db: DatabaseSync): { passwordCount: number; appBoundPasswordCount: number } {
  const columns = loginTableColumns(db)
  if (!columns.has('origin_url') || !columns.has('username_value') || !columns.has('password_value')) {
    return { passwordCount: 0, appBoundPasswordCount: 0 }
  }
  const filters = ["length(origin_url) > 0", "length(username_value) > 0", "length(password_value) > 0"]
  if (columns.has('blacklisted_by_user')) filters.push('blacklisted_by_user = 0')
  if (columns.has('blocked_by_user')) filters.push('blocked_by_user = 0')
  const row = db.prepare(
    `SELECT count(*) AS total,
      sum(CASE WHEN hex(substr(password_value, 1, 3)) = '763230' THEN 1 ELSE 0 END) AS app_bound
    FROM logins WHERE ${filters.join(' AND ')}`,
  ).get() as { total?: unknown; app_bound?: unknown }
  const total = Number(row?.total || 0)
  const passwordCount = Number.isSafeInteger(total) && total > 0 ? total : 0
  const appBound = Number(row?.app_bound || 0)
  const appBoundPasswordCount = Number.isSafeInteger(appBound) && appBound > 0
    ? Math.min(appBound, passwordCount)
    : 0
  return { passwordCount, appBoundPasswordCount }
}

async function findEdgeProfiles(): Promise<{ root: string | null; profiles: EdgeProfileSource[] }> {
  const root = edgeUserDataRoot()
  if (!root || !(await pathExists(root))) return { root, profiles: [] }
  const localState = await readLocalState(root)
  const infoCache = localState.profile?.info_cache || {}
  let children: import('fs').Dirent[]
  try {
    children = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return { root, profiles: [] }
  }

  const profileDirs = children
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, undefined, { numeric: true }))

  const profiles: EdgeProfileSource[] = []
  for (const id of profileDirs) {
    const loginDataPath = path.join(root, id, 'Login Data')
    if (!(await pathExists(loginDataPath))) continue
    let passwordCount = 0
    let appBoundPasswordCount = 0
    try {
      const inspected = await withLoginDatabase(loginDataPath, inspectLogins)
      passwordCount = inspected.passwordCount
      appBoundPasswordCount = inspected.appBoundPasswordCount
    } catch (err) {
      log.warn('passwords: could not inspect Edge profile metadata', { profile: id, err: String(err) })
    }
    profiles.push({
      id,
      name: String(infoCache[id]?.name || (id === 'Default' ? 'Default profile' : id)).slice(0, 200),
      passwordCount,
      appBoundPasswordCount,
      loginDataPath,
    })
  }
  return { root, profiles }
}

export async function detectEdgePasswords(): Promise<EdgePasswordSourceInfo> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return {
      installed: false,
      supported: false,
      profiles: [],
      passwordCount: 0,
      appBoundPasswordCount: 0,
      reason: 'Direct Microsoft Edge import is available on Windows and macOS.',
    }
  }
  const { root, profiles } = await findEdgeProfiles()
  const publicProfiles = profiles.map(({ id, name, passwordCount, appBoundPasswordCount }) => ({
    id,
    name,
    passwordCount,
    appBoundPasswordCount,
  }))
  return {
    installed: !!root && await pathExists(root),
    supported: true,
    profiles: publicProfiles,
    passwordCount: publicProfiles.reduce((total, profile) => total + profile.passwordCount, 0),
    appBoundPasswordCount: publicProfiles.reduce((total, profile) => total + profile.appBoundPasswordCount, 0),
  }
}

async function edgeExecutablePath(): Promise<string | null> {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => !!value)
  for (const root of roots) {
    const executable = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (await pathExists(executable)) return executable
  }
  return null
}

function launchEdgePasswordManager(executable: string, profileId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [`--profile-directory=${profileId}`, 'edge://wallet/passwords'], {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Open Edge's own authenticated export UI for one detected profile. */
export async function openEdgePasswordExport(profileId: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('The assisted Edge export flow is only needed on Windows.')
  }
  const { profiles } = await findEdgeProfiles()
  const profile = profiles.find((candidate) =>
    candidate.id === profileId && candidate.appBoundPasswordCount > 0,
  )
  if (!profile) throw new Error('That Microsoft Edge password profile was not found.')
  const executable = await edgeExecutablePath()
  if (!executable) throw new Error('Microsoft Edge could not be opened. Open Edge Passwords manually and export a CSV.')
  await launchEdgePasswordManager(executable, profile.id)
}

function runProcess(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim())
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Credential unlock exited with code ${code}.`))
    })
  })
}

async function macEdgeKey(): Promise<Buffer> {
  const secret = await runProcess('/usr/bin/security', [
    'find-generic-password',
    '-w',
    '-s', MAC_EDGE_SAFE_STORAGE_SERVICE,
    '-a', MAC_EDGE_SAFE_STORAGE_ACCOUNT,
  ])
  if (!secret) throw new Error('Microsoft Edge did not provide its Keychain encryption key.')
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')
}

async function windowsEdgeKey(root: string): Promise<Buffer> {
  const localState = await readLocalState(root)
  const encoded = localState.os_crypt?.encrypted_key
  if (!encoded) throw new Error('Microsoft Edge encryption metadata was not found.')
  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw new Error('Microsoft Edge uses an unsupported encryption-key format.')
  }
  const encryptedKey = wrapped.subarray(5).toString('base64')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String($env:NEWBRO_EDGE_WRAPPED_KEY)',
    '$key = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($key)',
  ].join('; ')
  const output = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    ...process.env,
    NEWBRO_EDGE_WRAPPED_KEY: encryptedKey,
  })
  const key = Buffer.from(output, 'base64')
  if (key.length !== 32) throw new Error('Microsoft Edge returned an invalid encryption key.')
  return key
}

function readLoginRows(db: DatabaseSync, remaining: number): EdgeLoginRow[] {
  const columns = loginTableColumns(db)
  if (!columns.has('origin_url') || !columns.has('username_value') || !columns.has('password_value')) return []
  const filters = ["length(origin_url) > 0", "length(username_value) > 0", "length(password_value) > 0"]
  if (columns.has('blacklisted_by_user')) filters.push('blacklisted_by_user = 0')
  if (columns.has('blocked_by_user')) filters.push('blocked_by_user = 0')
  return db.prepare(
    `SELECT origin_url, username_value, password_value FROM logins WHERE ${filters.join(' AND ')} LIMIT ?`,
  ).all(remaining) as unknown as EdgeLoginRow[]
}

export async function importEdgePasswords(partition: string): Promise<EdgePasswordImportResult> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('Direct Microsoft Edge import is available on Windows and macOS.')
  }
  // Validate the destination before asking the OS to unlock anything.
  const existingEntries = listPasswordEntries(partition)
  const { root, profiles } = await findEdgeProfiles()
  if (!root || profiles.length === 0) throw new Error('No Microsoft Edge password profiles were found.')

  const passwordCount = profiles.reduce((total, profile) => total + profile.passwordCount, 0)
  const appBoundPasswordCount = profiles.reduce((total, profile) => total + profile.appBoundPasswordCount, 0)
  if (process.platform === 'win32' && passwordCount > 0 && appBoundPasswordCount === passwordCount) {
    return {
      imported: 0,
      updated: 0,
      skipped: 0,
      invalid: 0,
      appBound: Math.min(appBoundPasswordCount, MAX_EDGE_PASSWORDS),
      unsupported: 0,
      profiles: profiles.filter((profile) => profile.appBoundPasswordCount > 0).length,
    }
  }

  let key: Buffer
  try {
    key = process.platform === 'darwin' ? await macEdgeKey() : await windowsEdgeKey(root)
  } catch (err) {
    log.warn('passwords: Edge OS credential unlock failed', { err: String(err) })
    throw new Error(
      process.platform === 'darwin'
        ? 'Edge passwords could not be unlocked. Allow Keychain access when macOS asks, then try again.'
        : 'Edge passwords could not be unlocked for this Windows account. Try again while signed in as the same user who saved them.',
    )
  }

  try {
    const result: EdgePasswordImportResult = {
      imported: 0,
      updated: 0,
      skipped: 0,
      invalid: 0,
      appBound: 0,
      unsupported: 0,
      profiles: 0,
    }
    const known = new Set(
      existingEntries.map((entry) => `${entry.origin}\u0000${entry.username}`),
    )

    for (const profile of profiles) {
      const processed = result.imported + result.updated + result.skipped + result.invalid + result.appBound + result.unsupported
      if (processed >= MAX_EDGE_PASSWORDS) break
      let rows: EdgeLoginRow[]
      try {
        rows = await withLoginDatabase(profile.loginDataPath, (db) => readLoginRows(db, MAX_EDGE_PASSWORDS - processed))
      } catch (err) {
        log.warn('passwords: could not read Edge profile during import', { profile: profile.id, err: String(err) })
        result.invalid += profile.passwordCount
        continue
      }
      if (rows.length > 0) result.profiles += 1

      for (const row of rows) {
        const blob = Buffer.from(row.password_value)
        const prefix = blob.subarray(0, 3).toString('ascii')
        if (process.platform === 'win32' && prefix === 'v20') {
          // Current Edge app-bound encryption is intentionally tied to Edge and
          // cannot be safely unwrapped by another desktop app.
          result.appBound += 1
          continue
        }
        const password = process.platform === 'darwin'
          ? decryptMacEdgePassword(blob, key)
          : decryptWindowsEdgePassword(blob, key)
        if (password === null) {
          result.unsupported += 1
          continue
        }
        const username = String(row.username_value || '').trim().slice(0, 16_384)
        if (!username || !password) {
          result.skipped += 1
          continue
        }
        try {
          const origin = normalizePasswordOrigin(String(row.origin_url || ''))
          const duplicateKey = `${origin}\u0000${username}`
          const existed = known.has(duplicateKey)
          await upsertPassword({ partition, origin, username, password })
          known.add(duplicateKey)
          if (existed) result.updated += 1
          else result.imported += 1
        } catch (err) {
          log.warn('passwords: skipped invalid Edge login metadata', { profile: profile.id, err: String(err) })
          result.invalid += 1
        }
      }
    }
    return result
  } finally {
    key.fill(0)
  }
}
