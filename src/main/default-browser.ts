// Default-browser registration for HTTP/HTTPS schemes.
//
// Platform reality:
//   • macOS  — `app.setAsDefaultProtocolClient` triggers the system "make
//     default" prompt directly.
//   • Linux  — it writes xdg-mime entries (best effort).
//   • Windows — `setAsDefaultProtocolClient` only writes a bare per-protocol
//     class under HKCU\Software\Classes. That is NOT enough for Windows 10/11:
//     the app never shows up in Settings → Default Apps, so the user can't pick
//     it, and `isDefaultProtocolClient` then reports a false positive off that
//     same class write (it sees our own ProgId, not the authoritative choice).
//
// What Windows actually needs is a *registered application* describing its
// capabilities: a StartMenuInternet client key + a Capabilities subkey with
// URLAssociations for http/https, a ProgId whose shell\open\command launches
// us, and a HKCU\Software\RegisteredApplications pointer so Windows scans all
// of it. We write that tree below (HKCU only — no elevation needed). Microsoft
// protects the actual default selection (the UserChoice hash) so NO app can
// flip the default programmatically; the user still confirms in Settings. But
// once we're registered, Newbro finally appears there as a candidate.
//
// We also read the *authoritative* default — the per-protocol UserChoice ProgId
// — instead of trusting `isDefaultProtocolClient`, so the UI stops claiming
// Newbro is the default when it isn't.
//
// `mailto` is intentionally excluded — Newbro is a browser, not an email
// client, and users typically want a separate handler for that scheme.

import { app, ipcMain, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { APP_NAME } from './branding'
import { log } from './log'

const execFileAsync = promisify(execFile)
const PROTOCOLS = ['http', 'https'] as const

// Registry identity, namespaced by APP_NAME so a dev build ("Newbro Dev")
// registers independently of a packaged install ("Newbro") — the two never
// fight over the same keys, and an uninstalled dev entry is easy to spot.
const REG_TOKEN = APP_NAME.replace(/[^A-Za-z0-9]/g, '') || 'Newbro' // Newbro / NewbroDev
const PROG_ID = `${REG_TOKEN}HTML` // NewbroHTML / NewbroDevHTML
const CLIENT_KEY = `HKCU\\Software\\Clients\\StartMenuInternet\\${REG_TOKEN}`
const CAPABILITIES_PATH = `Software\\Clients\\StartMenuInternet\\${REG_TOKEN}\\Capabilities`
const CAPABILITIES_KEY = `HKCU\\${CAPABILITIES_PATH}`
const PROGID_KEY = `HKCU\\Software\\Classes\\${PROG_ID}`
const REGISTERED_APPS_KEY = 'HKCU\\Software\\RegisteredApplications'
// The authoritative per-protocol default lives under the user's Shell
// associations. URL UserChoice is recorded WITHOUT a "CurrentVersion" segment
// — unlike file-extension UserChoice, which sits under
// CurrentVersion\Explorer\FileExts (an easy path to confuse). We probe both
// spellings so detection is robust across Windows builds.
const USERCHOICE_BASES = [
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Shell\\Associations\\UrlAssociations',
] as const

export interface DefaultBrowserStatus {
  platform: NodeJS.Platform
  /** True only when both http and https are bound to this app. */
  isDefault: boolean
  isDefaultHttp: boolean
  isDefaultHttps: boolean
  /** False on Windows: the OS protects the default selection, so the user must
   *  confirm in Settings → Default Apps. The renderer uses this to surface a
   *  different hint and a different button label. */
  canSetProgrammatically: boolean
}

export interface SetAsDefaultResult {
  status: DefaultBrowserStatus
  /** True when a separate OS pane was opened (Windows). The renderer should
   *  show a "now pick Newbro over there" hint while this is true. */
  openedSystemPane: boolean
}

// ── Windows registry helpers ──

/** `reg add` one value. Args go through execFile as an array (no shell), so
 *  reg.exe receives the data verbatim — embedded quotes and a literal %1
 *  survive intact (verified on Win11). */
async function regAdd(
  key: string,
  value: { name?: string; type?: string; data: string },
): Promise<void> {
  const args = ['add', key, '/f']
  if (value.name) args.push('/v', value.name)
  else args.push('/ve')
  args.push('/t', value.type ?? 'REG_SZ', '/d', value.data)
  await execFileAsync('reg', args)
}

/** The command Windows runs to open a URL with Newbro. Packaged: `"exe" "%1"`.
 *  In dev `process.execPath` is electron.exe, which needs the app directory
 *  before the URL argument. Either way `pickUrlFromArgv` (index.ts) finds the
 *  http(s) token, so an already-running instance handles the link. */
function launchCommand(withUrl: boolean): string {
  const exe = process.execPath
  const tail = withUrl ? ' "%1"' : ''
  if (app.isPackaged) return `"${exe}"${tail}`
  return `"${exe}" "${app.getAppPath()}"${tail}`
}

async function registerWindowsBrowser(): Promise<void> {
  const exe = process.execPath
  const icon = `${exe},0`
  const description = 'Workspace-based browser with profiles and tab groups'

  // ProgId — the handler Windows invokes once Newbro is chosen for a link.
  await regAdd(PROGID_KEY, { data: `${APP_NAME} HTML Document` })
  await regAdd(`${PROGID_KEY}\\DefaultIcon`, { data: icon })
  await regAdd(`${PROGID_KEY}\\shell\\open\\command`, { data: launchCommand(true) })

  // StartMenuInternet client + Capabilities — what makes Newbro show up as a
  // *browser* candidate in Settings → Default Apps. Mirrors the schema real
  // browsers use (verified against Chrome's keys on Win11).
  await regAdd(CLIENT_KEY, { data: APP_NAME })
  await regAdd(`${CLIENT_KEY}\\DefaultIcon`, { data: icon })
  await regAdd(`${CLIENT_KEY}\\shell\\open\\command`, { data: launchCommand(false) })
  await regAdd(CAPABILITIES_KEY, { name: 'ApplicationName', data: APP_NAME })
  await regAdd(CAPABILITIES_KEY, { name: 'ApplicationDescription', data: description })
  await regAdd(CAPABILITIES_KEY, { name: 'ApplicationIcon', data: icon })
  await regAdd(`${CAPABILITIES_KEY}\\Startmenu`, { name: 'StartMenuInternet', data: REG_TOKEN })
  for (const proto of PROTOCOLS) {
    await regAdd(`${CAPABILITIES_KEY}\\URLAssociations`, { name: proto, data: PROG_ID })
  }

  // Point RegisteredApplications at our Capabilities so Windows scans them.
  // Without this value Newbro never appears in the Default Apps picker.
  await regAdd(REGISTERED_APPS_KEY, { name: APP_NAME, data: CAPABILITIES_PATH })
}

/** True when our ProgId open-command already points at the *current* binary.
 *  Returns false after an update relocates the exe so we re-register. */
async function isRegisteredForCurrentExe(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      `${PROGID_KEY}\\shell\\open\\command`,
      '/ve',
    ])
    return stdout.includes(process.execPath)
  } catch {
    return false // key absent
  }
}

let registrationInFlight: Promise<void> | null = null

/** Register Newbro's browser capabilities in HKCU (idempotent, no elevation).
 *  No-op off Windows. Skips the writes when already registered for this exe
 *  unless `force` is set. Never throws — failure just means Newbro won't list
 *  in Default Apps, which the UI already accounts for. */
export function ensureWindowsBrowserRegistered(opts: { force?: boolean } = {}): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve()
  if (registrationInFlight) return registrationInFlight
  registrationInFlight = (async () => {
    try {
      if (!opts.force && (await isRegisteredForCurrentExe())) return
      await registerWindowsBrowser()
      log.info('default-browser: registered Windows capabilities', { regToken: REG_TOKEN })
    } catch (err) {
      log.warn('default-browser: registration failed', err)
    } finally {
      registrationInFlight = null
    }
  })()
  return registrationInFlight
}

/** Read the authoritative per-protocol default — the UserChoice ProgId Windows
 *  records when the user picks a handler. Absent until the user makes a choice
 *  (a system fallback like Edge does not write it). */
async function readUserChoiceProgId(proto: string): Promise<string | null> {
  for (const base of USERCHOICE_BASES) {
    try {
      const { stdout } = await execFileAsync('reg', [
        'query',
        `${base}\\${proto}\\UserChoice`,
        '/v',
        'ProgId',
      ])
      // Line: "    ProgId    REG_SZ    NewbroHTML"
      const m = stdout.match(/ProgId\s+REG_SZ\s+(.+?)\s*$/m)
      if (m) return m[1].trim()
    } catch {
      // Key absent at this spelling — fall through to the next.
    }
  }
  return null
}

async function readStatus(): Promise<DefaultBrowserStatus> {
  if (process.platform === 'win32') {
    const [httpId, httpsId] = await Promise.all([
      readUserChoiceProgId('http'),
      readUserChoiceProgId('https'),
    ])
    const isDefaultHttp = httpId === PROG_ID
    const isDefaultHttps = httpsId === PROG_ID
    return {
      platform: 'win32',
      isDefault: isDefaultHttp && isDefaultHttps,
      isDefaultHttp,
      isDefaultHttps,
      canSetProgrammatically: false,
    }
  }

  const isDefaultHttp = app.isDefaultProtocolClient('http')
  const isDefaultHttps = app.isDefaultProtocolClient('https')
  return {
    platform: process.platform,
    isDefault: isDefaultHttp && isDefaultHttps,
    isDefaultHttp,
    isDefaultHttps,
    canSetProgrammatically: true,
  }
}

async function setAsDefault(): Promise<SetAsDefaultResult> {
  if (process.platform === 'win32') {
    // Re-assert our registration (force, in case keys were clobbered), then
    // deep-link to Newbro's own Default Apps page so the user can confirm.
    // Windows ignores the query and shows the root page if it can't resolve it.
    await ensureWindowsBrowserRegistered({ force: true })
    let openedSystemPane = false
    try {
      await shell.openExternal(
        `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_NAME)}`,
      )
      openedSystemPane = true
    } catch (err) {
      log.warn('default-browser: failed to open ms-settings:defaultapps', err)
    }
    return { status: await readStatus(), openedSystemPane }
  }

  // macOS triggers the system prompt directly; Linux writes xdg-mime entries.
  for (const proto of PROTOCOLS) {
    const ok = app.setAsDefaultProtocolClient(proto)
    if (!ok) log.warn('setAsDefaultProtocolClient returned false', { proto })
  }
  return { status: await readStatus(), openedSystemPane: false }
}

export function registerDefaultBrowserIpc(): void {
  ipcMain.handle('default-browser:get-status', () => readStatus())
  ipcMain.handle('default-browser:set-default', () => setAsDefault())
  // Register in the background on startup so Newbro shows up in Default Apps
  // even before the user clicks "Make default" (and self-heals after updates).
  void ensureWindowsBrowserRegistered()
}
