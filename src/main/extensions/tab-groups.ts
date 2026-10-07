// Chrome tab groups for extensions, backed by Newbro's sidebar groups.
//
// A Newbro window shows one workspace, and its sidebar groups are Chrome's
// tab groups by another name: a titled, coloured, collapsible set of tabs.
// So chrome.tabGroups and chrome.tabs.group / ungroup operate on them
// directly:
//  - each window's renderer pushes a snapshot of its groups whenever they
//    change (renderer/src/lib/extension-tab-groups.ts); reads — get, query,
//    tab.groupId — are answered from those snapshots;
//  - writes are sent to the window's renderer and run as the same store
//    actions the sidebar uses, then read back from the next snapshot.
// Chrome's group ids are integers; ours are uuids, mapped here for the
// session. Empty groups don't exist for Chrome, so they're left out.

import { BrowserWindow, ipcMain } from 'electron'
import { log } from '../log'
import { registerExtensionApiHandler, type ExtensionApiCaller } from './api-ipc'
import { sendToExtensionWorkers } from './sw-bridge'
import { extensionHasPermission, extensionIdsWithPermission } from './manager'
import { notifyTabUpdated } from '../chrome-extensions-bridge'
import {
  getChromeTabIdForTab,
  getTabLocationForChromeTabId,
  getWebContentsByChromeTabId,
  pickPartitionForWindow,
} from '../tab-views'

interface GroupSnapshot {
  id: string
  name: string
  color: string
  collapsed: boolean
  /** Renderer tab ids. */
  tabIds: string[]
}

interface ChromeTabGroup {
  id: number
  title: string
  color: string
  collapsed: boolean
  windowId: number
}

// The sidebar palette is Edge's group palette, so Chrome's nine colours
// land on their twins; the three extra Newbro colours read back as the
// nearest Chrome one.
const CHROME_TO_HEX: Record<string, string> = {
  grey: '#9C9C9C',
  blue: '#5681B8',
  red: '#C46161',
  yellow: '#C4A140',
  green: '#7FB87F',
  pink: '#B488C9',
  purple: '#8E81C9',
  cyan: '#7AAFAF',
  orange: '#D08866',
}
const HEX_TO_CHROME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(CHROME_TO_HEX).map(([name, hex]) => [hex.toLowerCase(), name])),
  '#bd5e94': 'pink', // Magenta
  '#d6a87f': 'orange', // Peach
  '#7fa8d6': 'blue', // Sky
}

/** windowId → its groups, as last pushed by the window's renderer. */
const snapshots = new Map<number, GroupSnapshot[]>()
const chromeIdByGroup = new Map<string, number>()
const groupByChromeId = new Map<number, string>()
let nextChromeGroupId = 1

function chromeGroupId(groupId: string): number {
  let id = chromeIdByGroup.get(groupId)
  if (id === undefined) {
    id = nextChromeGroupId++
    chromeIdByGroup.set(groupId, id)
    groupByChromeId.set(id, groupId)
  }
  return id
}

function toChrome(windowId: number, g: GroupSnapshot): ChromeTabGroup {
  return {
    id: chromeGroupId(g.id),
    title: g.name,
    color: HEX_TO_CHROME[g.color.toLowerCase()] ?? 'grey',
    collapsed: g.collapsed,
    windowId,
  }
}

/** tab.groupId for chrome.tabs: the Chrome id of the sidebar group holding
 *  this tab, or -1 (TAB_GROUP_ID_NONE). */
export function chromeGroupIdForTab(chromeTabId: number): number {
  const loc = getTabLocationForChromeTabId(chromeTabId)
  if (!loc) return -1
  const group = snapshots.get(loc.windowId)?.find((g) => g.tabIds.includes(loc.tabId))
  return group ? chromeGroupId(group.id) : -1
}

function findGroup(chromeId: unknown): { windowId: number; group: GroupSnapshot } {
  const groupId = typeof chromeId === 'number' ? groupByChromeId.get(chromeId) : undefined
  if (groupId) {
    for (const [windowId, groups] of snapshots) {
      const group = groups.find((g) => g.id === groupId && g.tabIds.length > 0)
      if (group) return { windowId, group }
    }
  }
  throw new Error(`No group with id: ${String(chromeId)}.`)
}

/** Tell extensions that may listen (tabGroups permission) about a change
 *  in one window. */
function emitGroupEvent(windowId: number, type: 'created' | 'updated' | 'removed', group: ChromeTabGroup): void {
  const partition = pickPartitionForWindow(windowId)
  for (const extensionId of extensionIdsWithPermission('tabGroups')) {
    sendToExtensionWorkers(partition, extensionId, 'tabgroups-event', { type, group })
  }
}

function applySnapshot(windowId: number, raw: unknown): void {
  const next: GroupSnapshot[] = (Array.isArray(raw) ? raw : [])
    .filter((g): g is GroupSnapshot => !!g && typeof g.id === 'string' && Array.isArray(g.tabIds))
    .map((g) => ({
      id: g.id,
      name: String(g.name ?? ''),
      color: String(g.color ?? ''),
      collapsed: !!g.collapsed,
      tabIds: g.tabIds.filter((t): t is string => typeof t === 'string'),
    }))
  const prev = snapshots.get(windowId)
  snapshots.set(windowId, next)
  if (!prev) return // first snapshot of the window: nothing "changed"

  // Group lifecycle, as Chrome sees it (non-empty groups only).
  const live = (gs: GroupSnapshot[]) => new Map(gs.filter((g) => g.tabIds.length > 0).map((g) => [g.id, g]))
  const before = live(prev)
  const after = live(next)
  for (const [id, g] of after) {
    const old = before.get(id)
    if (!old) emitGroupEvent(windowId, 'created', toChrome(windowId, g))
    else if (old.name !== g.name || old.color !== g.color || old.collapsed !== g.collapsed) {
      emitGroupEvent(windowId, 'updated', toChrome(windowId, g))
    }
  }
  for (const [id, g] of before) {
    if (!after.has(id)) emitGroupEvent(windowId, 'removed', toChrome(windowId, g))
  }

  // Tabs that changed group get tabs.onUpdated with their new groupId.
  const membership = (gs: GroupSnapshot[]) => {
    const m = new Map<string, string>()
    for (const g of gs) for (const t of g.tabIds) m.set(t, g.id)
    return m
  }
  const oldOf = membership(prev)
  const newOf = membership(next)
  for (const tabId of new Set([...oldOf.keys(), ...newOf.keys()])) {
    if (oldOf.get(tabId) === newOf.get(tabId)) continue
    const chromeTabId = getChromeTabIdForTab(tabId)
    const wc = chromeTabId === null ? null : getWebContentsByChromeTabId(chromeTabId)
    if (wc) notifyTabUpdated(wc)
  }
}

// ── Writes: run in the window's renderer ──

let nextRequestId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

function requestRenderer(windowId: number, op: string, args: Record<string, unknown>): Promise<unknown> {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return Promise.reject(new Error(`No window with id: ${windowId}.`))
  return new Promise((resolve, reject) => {
    const id = nextRequestId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('The window did not respond.'))
    }, 5000)
    pending.set(id, { resolve, reject, timer })
    win.webContents.send('tabgroups:request', { id, op, args })
  })
}

/** Chrome tab ids → renderer tab ids, all in one window. */
function locateTabs(tabIds: unknown): { windowId: number; tabIds: string[] } {
  const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).filter((t): t is number => typeof t === 'number')
  if (ids.length === 0) throw new Error('No tab ids given.')
  let windowId: number | null = null
  const out: string[] = []
  for (const id of ids) {
    const loc = getTabLocationForChromeTabId(id)
    if (!loc) throw new Error(`No tab with id: ${id}.`)
    if (windowId !== null && loc.windowId !== windowId) {
      throw new Error('Tabs in different windows cannot be grouped together.')
    }
    windowId = loc.windowId
    out.push(loc.tabId)
  }
  return { windowId: windowId as number, tabIds: out }
}

async function group(args: Record<string, unknown>): Promise<number> {
  const { windowId, tabIds } = locateTabs(args.tabIds)
  if (args.groupId !== undefined) {
    const target = findGroup(args.groupId)
    if (target.windowId !== windowId) {
      throw new Error('Tabs must be in the same window as the group (moving between windows is not supported).')
    }
    await requestRenderer(windowId, 'group', { tabIds, groupId: target.group.id })
    return chromeGroupId(target.group.id)
  }
  const createdId = await requestRenderer(windowId, 'group', { tabIds })
  if (typeof createdId !== 'string') throw new Error('Could not create the group.')
  return chromeGroupId(createdId)
}

async function ungroup(args: Record<string, unknown>): Promise<void> {
  const ids = (Array.isArray(args.tabIds) ? args.tabIds : [args.tabIds]).filter((t): t is number => typeof t === 'number')
  // One renderer request per window the tabs live in.
  const byWindow = new Map<number, string[]>()
  for (const id of ids) {
    const loc = getTabLocationForChromeTabId(id)
    if (!loc) throw new Error(`No tab with id: ${id}.`)
    byWindow.set(loc.windowId, [...(byWindow.get(loc.windowId) ?? []), loc.tabId])
  }
  for (const [windowId, tabIds] of byWindow) await requestRenderer(windowId, 'ungroup', { tabIds })
}

async function update(args: Record<string, unknown>): Promise<ChromeTabGroup> {
  const { windowId, group: g } = findGroup(args.groupId)
  const props = (args.props && typeof args.props === 'object' ? args.props : {}) as Record<string, unknown>
  const color = typeof props.color === 'string' ? CHROME_TO_HEX[props.color] : undefined
  await requestRenderer(windowId, 'update', {
    groupId: g.id,
    title: typeof props.title === 'string' ? props.title : undefined,
    color,
    collapsed: typeof props.collapsed === 'boolean' ? props.collapsed : undefined,
  })
  return toChrome(windowId, findGroup(args.groupId).group)
}

function query(info: Record<string, unknown>): ChromeTabGroup[] {
  let windowId = typeof info.windowId === 'number' ? info.windowId : undefined
  if (windowId === -2) windowId = BrowserWindow.getFocusedWindow()?.id // WINDOW_ID_CURRENT
  const out: ChromeTabGroup[] = []
  for (const [wid, groups] of snapshots) {
    if (windowId !== undefined && wid !== windowId) continue
    for (const g of groups) {
      if (g.tabIds.length === 0) continue
      const cg = toChrome(wid, g)
      if (typeof info.collapsed === 'boolean' && cg.collapsed !== info.collapsed) continue
      if (typeof info.color === 'string' && cg.color !== info.color) continue
      if (typeof info.title === 'string' && cg.title !== info.title) continue
      out.push(cg)
    }
  }
  return out
}

function requireTabGroups(caller: ExtensionApiCaller): void {
  if (!extensionHasPermission(caller.extensionId, 'tabGroups')) {
    throw new Error('The "tabGroups" permission is required.')
  }
}

export function registerTabGroupsIpc(): void {
  ipcMain.on('tabgroups:snapshot', (e, groups: unknown) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (!snapshots.has(win.id)) {
      const windowId = win.id
      win.once('closed', () => {
        const groups = snapshots.get(windowId) ?? []
        snapshots.delete(windowId)
        for (const g of groups) {
          if (g.tabIds.length > 0) emitGroupEvent(windowId, 'removed', toChrome(windowId, g))
        }
      })
    }
    applySnapshot(win.id, groups)
  })

  ipcMain.on('tabgroups:response', (_e, id: number, response: { result?: unknown; error?: string }) => {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    if (response?.error) p.reject(new Error(response.error))
    else p.resolve(response?.result)
  })

  registerExtensionApiHandler('tabgroups', (caller, payload) => {
    const { op, args } = (payload ?? {}) as { op?: unknown; args?: unknown }
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
    if (op !== 'query' && op !== 'get') log.info('tabgroups: call', { extensionId: caller.extensionId, op, args: a })
    switch (op) {
      // chrome.tabs.group / ungroup — part of chrome.tabs, no permission.
      case 'group':
        return group(a)
      case 'ungroup':
        return ungroup(a)
      case 'get': {
        requireTabGroups(caller)
        const { windowId, group: g } = findGroup(a.groupId)
        return toChrome(windowId, g)
      }
      case 'query':
        requireTabGroups(caller)
        return query(a)
      case 'update':
        requireTabGroups(caller)
        return update(a)
      case 'move': {
        // Reordering groups by tab index has no sidebar equivalent; report
        // the group where it is.
        requireTabGroups(caller)
        const { windowId, group: g } = findGroup(a.groupId)
        return toChrome(windowId, g)
      }
      default:
        throw new Error(`tabGroups.${String(op)} is not supported`)
    }
  })
}
