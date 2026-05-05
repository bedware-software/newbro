// Default-browser registration for HTTP/HTTPS schemes.
//
// `app.setAsDefaultProtocolClient` is fully effective on macOS (triggers the
// system "make default" prompt) and best-effort on Linux (writes xdg-mime
// entries). On Windows 10+ it only registers the app as a *candidate* in the
// registry; the user must still pick Newbro by hand in Settings → Default
// Apps. We deep-link into that pane via `ms-settings:defaultapps` so the
// renderer can be honest about that flow instead of pretending the button
// finished the job.
//
// `mailto` is intentionally excluded — Newbro is a browser, not an email
// client, and users typically want a separate handler for that scheme.

import { app, ipcMain, shell } from 'electron'
import { log } from './log'

const PROTOCOLS = ['http', 'https'] as const

export interface DefaultBrowserStatus {
  platform: NodeJS.Platform
  /** True only when both http and https are bound to this app. */
  isDefault: boolean
  isDefaultHttp: boolean
  isDefaultHttps: boolean
  /** False on Windows: the registry write we make doesn't actually pick the
   *  app — the user must confirm in Settings → Default Apps. The renderer
   *  uses this to surface a different hint and a different button label. */
  canSetProgrammatically: boolean
}

export interface SetAsDefaultResult {
  status: DefaultBrowserStatus
  /** True when a separate OS pane was opened (Windows). The renderer should
   *  show a "now pick Newbro over there" hint while this is true. */
  openedSystemPane: boolean
}

function readStatus(): DefaultBrowserStatus {
  const isDefaultHttp = app.isDefaultProtocolClient('http')
  const isDefaultHttps = app.isDefaultProtocolClient('https')
  return {
    platform: process.platform,
    isDefault: isDefaultHttp && isDefaultHttps,
    isDefaultHttp,
    isDefaultHttps,
    canSetProgrammatically: process.platform !== 'win32',
  }
}

async function setAsDefault(): Promise<SetAsDefaultResult> {
  // Register the app as a candidate for both protocols. On Windows this is a
  // registry write that's required before Newbro even appears in the
  // default-apps picker. On macOS this triggers the system prompt directly.
  // On Linux this calls xdg-mime under the hood.
  for (const proto of PROTOCOLS) {
    const ok = app.setAsDefaultProtocolClient(proto)
    if (!ok) log.warn('setAsDefaultProtocolClient returned false', { proto })
  }

  let openedSystemPane = false
  if (process.platform === 'win32') {
    try {
      await shell.openExternal('ms-settings:defaultapps')
      openedSystemPane = true
    } catch (err) {
      log.warn('failed to open ms-settings:defaultapps', err)
    }
  }
  return { status: readStatus(), openedSystemPane }
}

export function registerDefaultBrowserIpc(): void {
  ipcMain.handle('default-browser:get-status', (): DefaultBrowserStatus => readStatus())
  ipcMain.handle(
    'default-browser:set-default',
    async (): Promise<SetAsDefaultResult> => await setAsDefault(),
  )
}
