// Passing a link on to another browser. A link another app hands Newbro (as
// the default browser) lands in the Open Link picker; ⌘↵ (Ctrl+Enter on
// Windows) there opens it in a browser the user picked once instead — Safari,
// Chrome, Edge — for a site that works better there, like one whose passkey
// is in iCloud Keychain and wants Touch ID (webauthn.ts can only reach those
// through an iPhone). macOS and Windows.
//
// The choice names an app installed on this computer, so it's kept here, in
// its own store, rather than in Settings, which Cloud Sync carries to devices
// that may not have that app.

import { app, ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { resolve } from 'path'
import { promisify } from 'util'
import Store from 'electron-store'
import { log } from './log'
import { isAppUiSender } from './vault-access'

const execFileAsync = promisify(execFile)

export interface OtherBrowser {
  /** macOS: the bundle identifier, e.g. com.apple.Safari. Windows: the
   *  browser's StartMenuInternet key, e.g. "Google Chrome". */
  id: string
  name: string
}

export type OpenResult =
  | { opened: true; browser: OtherBrowser }
  /** No browser chosen yet, or the chosen one couldn't open the link (it was
   *  removed, say): the picker asks which browser, from `browsers`. */
  | { opened: false; browsers: OtherBrowser[]; failed?: OtherBrowser }

const store = new Store<{ browser: OtherBrowser | null }>({
  name: 'newbro-other-browser',
  defaults: { browser: null },
})

const supported = process.platform === 'darwin' || process.platform === 'win32'

function asBrowser(value: unknown): OtherBrowser | null {
  const { id, name } = (value ?? {}) as { id?: unknown; name?: unknown }
  if (typeof id !== 'string' || typeof name !== 'string') return null
  const valid = process.platform === 'win32'
    // A registry key name: no path separator or control characters.
    ? id.length > 0 && id.length <= 255 && !/[\\\x00-\x1f]/.test(id)
    : /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(id)
  return valid ? { id, name: name.slice(0, 200) || id } : null
}

function addBrowser(browsers: OtherBrowser[], value: unknown): OtherBrowser | null {
  const browser = asBrowser(value)
  if (!browser || browsers.some((b) => b.id === browser.id)) return null
  browsers.push(browser)
  return browser
}

// ── macOS ──

// Every app macOS would open an https link with — the apps the Finder's Open
// With menu offers for one — read through NSWorkspace from JavaScript for
// Automation, so no native helper is needed.
const MAC_LIST_SCRIPT = `
ObjC.import('AppKit')
const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.URLWithString('https://example.com'))
const apps = []
for (let i = 0; i < urls.count; i++) {
  const url = urls.objectAtIndex(i)
  const bundle = $.NSBundle.bundleWithURL(url)
  if (bundle.isNil() || bundle.bundleIdentifier.isNil()) continue
  apps.push({
    id: bundle.bundleIdentifier.js,
    name: $.NSFileManager.defaultManager.displayNameAtPath(url.path).js,
    path: url.path.js,
  })
}
JSON.stringify(apps)
`

async function listMacBrowsers(): Promise<OtherBrowser[]> {
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_LIST_SCRIPT], { timeout: 10_000 })
  const apps = JSON.parse(stdout) as Array<{ id: string; name: string; path: string }>
  // Contents/MacOS/<exe> → the .app bundle (Electron.app in a dev run).
  const ownBundle = resolve(app.getPath('exe'), '../../..')
  const browsers: OtherBrowser[] = []
  for (const entry of apps) {
    if (entry.path === ownBundle || entry.id.startsWith('com.newbro.')) continue
    // Test builds tools keep in hidden cache folders (puppeteer's Chrome for
    // Testing) aren't anyone's browser.
    if (entry.path.split('/').some((part) => part.startsWith('.'))) continue
    addBrowser(browsers, entry)
  }
  return browsers
}

function openOnMac(browser: OtherBrowser, url: string): Promise<unknown> {
  return execFileAsync('/usr/bin/open', ['-b', browser.id, url], { timeout: 10_000 })
}

// ── Windows ──

// The browsers Windows lists in Default Apps: each registers a key under
// Clients\StartMenuInternet (per user, per machine, and the 32-bit view) whose
// default value is its name and whose shell\open\command starts it.
// PowerShell rather than reg.exe: reg.exe prints in the console code page and
// labels the default value in the system language, which mangles a Cyrillic
// user folder in a per-user browser's path. UTF-8 without a BOM, as JSON.
const WINDOWS_LIST_SCRIPT = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$browsers = @(foreach ($root in 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet') {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($key in Get-ChildItem -LiteralPath $root) {
    $command = $key.OpenSubKey('shell\\open\\command')
    if (-not $command) { continue }
    [pscustomobject]@{ id = $key.PSChildName; name = [string]$key.GetValue(''); command = [string]$command.GetValue('') }
  }
})
ConvertTo-Json -Compress -InputObject $browsers
`

/** Each listed browser's start command, by id, from the last listing. */
const windowsCommands = new Map<string, string>()

/** The program a StartMenuInternet command starts: a quoted path, or an
 *  unquoted one up to ".exe". */
export function exeOf(command: string): string | null {
  const trimmed = command.trim()
  const quoted = /^"([^"]+)"/.exec(trimmed)
  const exe = quoted ? quoted[1] : /^(.+?\.exe)(?=\s|$)/i.exec(trimmed)?.[1]
  return exe && /\.exe$/i.test(exe) ? exe : null
}

/** The listing script's JSON → browsers, Newbro itself left out. HKCU comes
 *  first, and wins over the machine-wide key of the same name. */
export function parseWindowsBrowsers(json: string, ownExe: string): Array<OtherBrowser & { exe: string }> {
  const parsed = JSON.parse(json.replace(/^﻿/, '') || '[]') as unknown
  // ConvertTo-Json writes a lone browser as an object, not a one-item array.
  const entries = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id?: unknown; name?: unknown; command?: unknown } | null>
  const browsers: OtherBrowser[] = []
  const out: Array<OtherBrowser & { exe: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const exe = typeof entry.command === 'string' ? exeOf(entry.command) : null
    if (!exe || exe.toLowerCase() === ownExe.toLowerCase()) continue
    // Newbro's own registration (default-browser.ts): "Newbro", "NewbroDev".
    if (typeof entry.id === 'string' && /^Newbro(Dev)?$/i.test(entry.id)) continue
    const browser = addBrowser(browsers, { id: entry.id, name: entry.name || entry.id })
    if (browser) out.push({ ...browser, exe })
  }
  return out
}

async function listWindowsBrowsers(): Promise<OtherBrowser[]> {
  // -EncodedCommand (UTF-16LE base64) carries the script past command-line
  // quoting intact.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_LIST_SCRIPT, 'utf16le').toString('base64')],
    { timeout: 15_000, windowsHide: true },
  )
  const browsers = parseWindowsBrowsers(stdout.trim(), process.execPath)
  windowsCommands.clear()
  for (const browser of browsers) windowsCommands.set(browser.id, browser.exe)
  return browsers.map(({ id, name }) => ({ id, name }))
}

async function openOnWindows(browser: OtherBrowser, url: string): Promise<void> {
  if (!windowsCommands.has(browser.id)) await listWindowsBrowsers()
  const exe = windowsCommands.get(browser.id)
  if (!exe) throw new Error(`${browser.name} isn't installed.`)
  await new Promise<void>((done, fail) => {
    // Detached: the browser outlives Newbro. A running browser takes the URL
    // into its open window, as it does for a link from any other app.
    const child = spawn(exe, [url], { detached: true, stdio: 'ignore' })
    child.once('error', (err) => {
      // Moved or uninstalled since the last listing.
      windowsCommands.delete(browser.id)
      fail(err)
    })
    child.once('spawn', () => {
      child.unref()
      done()
    })
  })
}

// ── Both ──

/** Browsers installed here, Newbro itself left out. */
export async function listBrowsers(): Promise<OtherBrowser[]> {
  if (!supported) return []
  const browsers = process.platform === 'win32' ? await listWindowsBrowsers() : await listMacBrowsers()
  return browsers.sort((a, b) => a.name.localeCompare(b.name))
}

function isLink(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Opens `url` in the browser the user chose — or in `pick`, which becomes
 *  the choice. */
async function openInOtherBrowser(url: string, pick: OtherBrowser | null): Promise<OpenResult> {
  if (pick) store.set('browser', pick)
  const browser = pick ?? store.get('browser')
  if (browser) {
    try {
      if (process.platform === 'win32') await openOnWindows(browser, url)
      else await openOnMac(browser, url)
      log.info('other-browser: opened link', { browser: browser.id })
      return { opened: true, browser }
    } catch (err) {
      log.warn('other-browser: open failed', { browser: browser.id, err: String(err) })
      return { opened: false, browsers: await listBrowsers(), failed: browser }
    }
  }
  return { opened: false, browsers: await listBrowsers() }
}

export function registerOtherBrowserIpc(): void {
  ipcMain.handle('other-browser:get', (event) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    return store.get('browser')
  })
  ipcMain.handle('other-browser:list', (event) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    return listBrowsers()
  })
  // Settings: change the browser, or clear it (null) to be asked again.
  ipcMain.handle('other-browser:set', (event, browser: unknown) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    store.set('browser', browser === null ? null : asBrowser(browser))
    return store.get('browser')
  })
  ipcMain.handle('other-browser:open', (event, url: unknown, pick: unknown) => {
    if (!isAppUiSender(event)) throw new Error('Not allowed.')
    if (!supported) throw new Error('Passing links on works on macOS and Windows.')
    if (!isLink(url)) throw new Error('Only web links can be passed on.')
    const chosen = pick === undefined || pick === null ? null : asBrowser(pick)
    if (pick != null && !chosen) throw new Error('Not a browser.')
    return openInOtherBrowser(url, chosen)
  })
}
