// chrome.debugger for Newbro, over Electron's webContents.debugger.
//
// Chrome's debugger API attaches an extension to a tab's DevTools
// protocol session. Electron exposes the same session per webContents,
// so attach / sendCommand / detach map one-to-one onto the tab's
// webContents.debugger, and its 'message' / 'detach' events become
// chrome.debugger.onEvent / onDetach in the extension — pushed to its
// service worker, and to the page that attached when a page did. Claude
// in Chrome takes its screenshots and drives clicks and typing this way.
//
// Only tab targets: Newbro has no chrome.debugger for extension or
// browser targets.

import type { WebContents } from 'electron'
import { log } from '../log'
import { registerExtensionApiHandler, type ExtensionApiCaller } from './api-ipc'
import { sendToExtensionWorkers } from './sw-bridge'
import { extensionHasPermission, onExtensionDeactivated } from './manager'
import { getWebContentsByChromeTabId, listChromeTabs } from '../tab-views'

interface Attachment {
  tabId: number
  wc: WebContents
  caller: ExtensionApiCaller
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: (event: unknown, reason: string) => void
}

/** One extension per tab, as in Chrome. Keyed by Chrome tab id. */
const attachments = new Map<number, Attachment>()

function targetTabId(target: unknown): number {
  const tabId = (target as { tabId?: unknown } | null)?.tabId
  if (typeof tabId === 'number') return tabId
  throw new Error('Only tab targets are supported (tabId).')
}

/** Deliver a debugger event the way Chrome would: to the extension's
 *  listeners — its service worker, plus the page that attached. */
function emit(caller: ExtensionApiCaller, channel: string, payload: unknown): void {
  sendToExtensionWorkers(caller.partition, caller.extensionId, channel, payload)
  const frame = caller.frame
  if (frame && !frame.isDestroyed()) frame.send('newbro-ext-frame-event', channel, payload)
}

function release(att: Attachment): void {
  attachments.delete(att.tabId)
  if (att.wc.isDestroyed()) return
  att.wc.debugger.removeListener('message', att.onMessage)
  att.wc.debugger.removeListener('detach', att.onDetach)
}

function attach(caller: ExtensionApiCaller, args: Record<string, unknown>): void {
  const tabId = targetTabId(args.target)
  const wc = getWebContentsByChromeTabId(tabId)
  if (!wc) throw new Error(`No tab with given id ${tabId}.`)
  if (attachments.has(tabId) || wc.debugger.isAttached()) {
    throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
  }
  wc.debugger.attach(typeof args.requiredVersion === 'string' ? args.requiredVersion : '1.3')
  const att: Attachment = {
    tabId,
    wc,
    caller,
    onMessage: (_event, method, params, sessionId) => {
      emit(caller, 'debugger-event', { source: sessionId ? { tabId, sessionId } : { tabId }, method, params })
    },
    onDetach: (_event, reason) => {
      if (attachments.get(tabId) !== att) return
      release(att)
      log.info('debugger: detached by target', { extensionId: caller.extensionId, tabId, reason })
      // Electron says "target closed" / "Render process gone." — Chrome's
      // vocabulary is target_closed / canceled_by_user.
      const chromeReason = /closed|gone/i.test(reason) ? 'target_closed' : 'canceled_by_user'
      emit(caller, 'debugger-detach', { source: { tabId }, reason: chromeReason })
    },
  }
  wc.debugger.on('message', att.onMessage)
  wc.debugger.on('detach', att.onDetach)
  attachments.set(tabId, att)
  log.info('debugger: attached', { extensionId: caller.extensionId, tabId })
}

function ownAttachment(caller: ExtensionApiCaller, target: unknown): Attachment {
  const tabId = targetTabId(target)
  const att = attachments.get(tabId)
  if (!att || att.caller.extensionId !== caller.extensionId || att.wc.isDestroyed()) {
    throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`)
  }
  return att
}

function detach(caller: ExtensionApiCaller, args: Record<string, unknown>): void {
  const att = ownAttachment(caller, args.target)
  // An explicit detach fires no onDetach in Chrome — drop our listeners
  // before Electron emits its own 'detach'.
  release(att)
  try {
    att.wc.debugger.detach()
  } catch (err) {
    log.warn('debugger: detach threw', { tabId: att.tabId, err: String(err) })
  }
  log.info('debugger: detached', { extensionId: caller.extensionId, tabId: att.tabId })
}

async function sendCommand(caller: ExtensionApiCaller, args: Record<string, unknown>): Promise<unknown> {
  const att = ownAttachment(caller, args.target)
  if (typeof args.method !== 'string') throw new Error('sendCommand requires a method.')
  const sessionId = (args.target as { sessionId?: unknown }).sessionId
  const params = args.params && typeof args.params === 'object' ? args.params : {}
  return att.wc.debugger.sendCommand(args.method, params, typeof sessionId === 'string' ? sessionId : undefined)
}

function getTargets(): unknown[] {
  return listChromeTabs().map((t) => ({
    type: 'page',
    id: String(t.chromeTabId),
    tabId: t.chromeTabId,
    url: t.url,
    title: t.title,
    attached: attachments.has(t.chromeTabId),
  }))
}

export function registerDebuggerIpc(): void {
  registerExtensionApiHandler('debugger', (caller, payload) => {
    if (!extensionHasPermission(caller.extensionId, 'debugger')) {
      throw new Error('The "debugger" permission is required.')
    }
    const { op, args } = (payload ?? {}) as { op?: unknown; args?: unknown }
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    switch (op) {
      case 'attach':
        return attach(caller, a)
      case 'detach':
        return detach(caller, a)
      case 'sendCommand':
        return sendCommand(caller, a)
      case 'getTargets':
        return getTargets()
      default:
        throw new Error(`debugger.${String(op)} is not supported`)
    }
  })

  // A disabled / uninstalled extension loses its sessions, as in Chrome.
  onExtensionDeactivated((extensionId) => {
    for (const att of [...attachments.values()]) {
      if (att.caller.extensionId !== extensionId) continue
      release(att)
      try { if (!att.wc.isDestroyed()) att.wc.debugger.detach() } catch { /* already gone */ }
    }
  })
}
