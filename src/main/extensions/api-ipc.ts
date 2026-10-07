// One registration point for the chrome.* polyfills the extension-shim
// preload installs (chrome.sidePanel, chrome.identity, ...). Their calls
// arrive from two kinds of extension context:
//   - service workers, over the SW bridge's 'newbro-sw' invoke
//   - pages (side panel, popup, options), over ipcMain 'newbro-ext-frame'
// Both resolve to { ok: true, data } | { ok: false, error }, and a handler
// sees the same caller shape either way.

import { ipcMain, type WebContents } from 'electron'
import { registerSwInvokeHandler } from './sw-bridge'
import { getPartitionForSession } from '../index'

export interface ExtensionApiCaller {
  partition: string
  extensionId: string
  /** The calling page; absent for service workers. Events for page
   *  callers go to it as 'newbro-ext-frame-event' (channel, payload). */
  frame?: WebContents
}

type Handler = (caller: ExtensionApiCaller, payload: unknown) => unknown | Promise<unknown>

const frameHandlers = new Map<string, Handler>()

export function registerExtensionApiHandler(channel: string, handler: Handler): void {
  registerSwInvokeHandler(channel, (ctx, payload) =>
    handler({ partition: ctx.partition, extensionId: ctx.extensionId }, payload),
  )
  frameHandlers.set(channel, handler)
}

export function registerExtensionFrameIpc(): void {
  ipcMain.handle('newbro-ext-frame', async (e, channel: unknown, payload: unknown) => {
    // The caller is whatever chrome-extension:// page sent this; web
    // pages never get the preload's ipcRenderer, but check anyway.
    let extensionId: string
    try {
      const url = new URL(e.senderFrame?.url || e.sender.getURL())
      if (url.protocol !== 'chrome-extension:') return { ok: false, error: 'not an extension page' }
      extensionId = url.hostname
    } catch {
      return { ok: false, error: 'not an extension page' }
    }
    const handler = frameHandlers.get(String(channel))
    if (!handler) return { ok: false, error: `no handler for '${String(channel)}'` }
    try {
      const data = await handler(
        { partition: getPartitionForSession(e.sender.session), extensionId, frame: e.sender },
        payload,
      )
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
