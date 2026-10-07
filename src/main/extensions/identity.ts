// chrome.identity.launchWebAuthFlow for Newbro.
//
// Chrome opens the provider's auth URL in a browser-owned window and
// finishes the flow when the provider redirects to
// https://<extension-id>.chromiumapp.org/… — that URL (with its code /
// token) is the call's result, and the request itself never hits the
// network. We do the same with a BrowserWindow in the extension's profile
// partition, so the provider sees the user's existing login cookies
// (Claude refreshes its token this way, non-interactively).
//
// The chrome.identity namespace is installed by the extension-shim
// preload; getRedirectURL is computed there, launchWebAuthFlow lands here.

import { BrowserWindow } from 'electron'
import { log } from '../log'
import { registerExtensionApiHandler, type ExtensionApiCaller } from './api-ipc'

// Chrome's own error strings — extensions pattern-match on them.
const ERR_INTERACTION_REQUIRED = 'User interaction required.'
const ERR_NOT_APPROVED = 'The user did not approve access.'
const ERR_LOAD_FAILED = 'Authorization page could not be loaded.'

/** Electron 41 passes navigation events a details object; older
 *  signatures pass the URL as the second argument. */
function eventUrl(details: unknown, legacyUrl: unknown): string {
  const url = (details as { url?: unknown } | null)?.url
  return typeof url === 'string' ? url : typeof legacyUrl === 'string' ? legacyUrl : ''
}

function launchWebAuthFlow(caller: ExtensionApiCaller, payload: unknown): Promise<string> {
  const args = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const url = typeof args.url === 'string' ? args.url : ''
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error(ERR_LOAD_FAILED))
  const interactive = args.interactive === true
  // Non-interactive flows give up when the page finishes loading without
  // redirecting (Chrome's default) unless the caller opts into waiting.
  const abortOnLoad = args.abortOnLoadForNonInteractive !== false
  const timeoutMs = typeof args.timeoutMsForNonInteractive === 'number' ? args.timeoutMsForNonInteractive : 0
  const redirectPrefix = `https://${caller.extensionId}.chromiumapp.org/`

  const win = new BrowserWindow({
    show: interactive,
    width: 520,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: { partition: caller.partition, contextIsolation: true, sandbox: true },
  })
  const wc = win.webContents
  log.info('identity: launchWebAuthFlow', { extensionId: caller.extensionId, interactive, abortOnLoad, timeoutMs })

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (err: Error | null, result?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      log.info('identity: launchWebAuthFlow finished', { extensionId: caller.extensionId, ok: !err, err: err?.message })
      if (err) reject(err)
      else resolve(result ?? '')
    }
    // The provider's final hop to chromiumapp.org: take the URL, never
    // load it (the host doesn't exist).
    const intercept = (e: { preventDefault(): void } | null, target: string): boolean => {
      if (!target.startsWith(redirectPrefix)) return false
      e?.preventDefault()
      finish(null, target)
      return true
    }
    wc.on('will-redirect', (details, legacyUrl) => intercept(details, eventUrl(details, legacyUrl)))
    wc.on('will-navigate', (details, legacyUrl) => intercept(details, eventUrl(details, legacyUrl)))
    wc.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || intercept(null, validatedURL)) return
      // -3 is ERR_ABORTED: our own preventDefault, or a superseded load.
      if (errorCode !== -3) finish(new Error(ERR_LOAD_FAILED))
    })
    if (!interactive) {
      if (abortOnLoad) {
        wc.on('did-finish-load', () => setImmediate(() => finish(new Error(ERR_INTERACTION_REQUIRED))))
      }
      if (timeoutMs > 0) timer = setTimeout(() => finish(new Error(ERR_INTERACTION_REQUIRED)), timeoutMs)
      else if (!abortOnLoad) timer = setTimeout(() => finish(new Error(ERR_INTERACTION_REQUIRED)), 60_000)
    }
    win.on('closed', () => finish(new Error(ERR_NOT_APPROVED)))
    win.loadURL(url).catch(() => {
      /* failures surface through did-fail-load / the redirect intercept */
    })
  })
}

export function registerIdentityIpc(): void {
  registerExtensionApiHandler('identity', (caller, payload) => {
    const { op, args } = (payload ?? {}) as { op?: unknown; args?: unknown }
    if (op === 'launchWebAuthFlow') return launchWebAuthFlow(caller, args)
    throw new Error(`identity.${String(op)} is not supported`)
  })
}
