// Device check before Settings → Passwords shows or copies a saved password.
//
// Chrome and Edge confirm the device owner (Touch ID / the system password)
// the first time, then let the user browse the vault for the rest of the
// session ("ask permission once per browsing session"). We do the same where
// Electron can ask the OS: macOS with Touch ID. Elsewhere the OS offers
// Electron no prompt, so access is granted without one.
//
// Only the app's own UI may ask: tab pages have their own preload with no
// route here, and the sender check keeps it that way.

import { BrowserWindow, systemPreferences } from 'electron'
import { log } from './log'

let unlocked = false
let pending: Promise<boolean> | null = null

/** True when the IPC call comes from a window's own UI renderer — never from
 *  a tab page (a WebContentsView) or a subframe. */
export function isAppUiSender(event: Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender)
  return !!win && win.webContents === event.sender && event.senderFrame === event.sender.mainFrame
}

/** Resolves true once the vault is open for this session, asking the OS for
 *  the device owner the first time. Concurrent callers share one prompt. */
export function ensureVaultAccess(): Promise<boolean> {
  if (unlocked) return Promise.resolve(true)
  if (pending) return pending
  pending = (async () => {
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try {
        // macOS renders this as "Newbro is trying to show saved passwords."
        await systemPreferences.promptTouchID('show saved passwords')
      } catch (err) {
        log.info('vault-access: device check declined', String(err))
        return false
      }
    }
    unlocked = true
    return true
  })().finally(() => { pending = null })
  return pending
}
