// Bridge between Chrome's tab-group API (chrome.tabGroups, chrome.tabs.group
// / ungroup — see main/extensions/tab-groups.ts) and this window's sidebar
// groups, which are the same thing. Main answers extensions' reads from the
// snapshot we push whenever the window's groups change, and sends their
// writes here to run as ordinary store actions — so an extension grouping
// tabs looks exactly like the user doing it.

import { useAppStore } from '../store/app-store'

interface GroupSnapshot {
  id: string
  name: string
  color: string
  collapsed: boolean
  tabIds: string[]
}

interface TabGroupsRequest {
  id: number
  op: string
  args: Record<string, unknown>
}

function activeWorkspace() {
  const s = useAppStore.getState()
  for (const p of s.profiles) {
    const w = p.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (w) return w
  }
  return undefined
}

function snapshot(): GroupSnapshot[] {
  return (activeWorkspace()?.tabGroups ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    collapsed: g.isCollapsed,
    tabIds: g.tabs.map((t) => t.id),
  }))
}

function handle(op: string, args: Record<string, unknown>): unknown {
  const store = useAppStore.getState()
  const workspace = activeWorkspace()
  if (!workspace) throw new Error('No workspace in this window.')
  const tabIds = Array.isArray(args.tabIds) ? (args.tabIds as string[]) : []
  switch (op) {
    case 'group': {
      const groupId = typeof args.groupId === 'string' ? args.groupId : null
      if (groupId) {
        const group = workspace.tabGroups.find((g) => g.id === groupId)
        if (!group) throw new Error('No such group in this window.')
        store.moveTabs(tabIds, groupId, group.tabs.length)
        return groupId
      }
      const created = store.groupTabsInNewGroup(tabIds, '', typeof args.color === 'string' ? args.color : undefined)
      if (!created) throw new Error('None of the tabs are in this window.')
      return created
    }
    case 'ungroup': {
      for (const id of tabIds) {
        if (workspace.tabGroups.some((g) => g.tabs.some((t) => t.id === id))) store.ungroupTab(id)
      }
      return undefined
    }
    case 'update': {
      const group = workspace.tabGroups.find((g) => g.id === args.groupId)
      if (!group) throw new Error('No such group in this window.')
      if (typeof args.title === 'string' && args.title !== group.name) store.renameTabGroup(group.id, args.title)
      if (typeof args.color === 'string' && args.color !== group.color) store.setTabGroupColor(group.id, args.color)
      if (typeof args.collapsed === 'boolean' && args.collapsed !== group.isCollapsed) {
        store.toggleTabGroupCollapse(group.id)
      }
      return undefined
    }
    default:
      throw new Error(`Unsupported tab group operation: ${op}`)
  }
}

/** Start pushing this window's groups to main and serving its requests.
 *  Returns the cleanup. */
export function startExtensionTabGroupsBridge(): () => void {
  const api = window.electronAPI
  let last = ''
  const push = (): void => {
    const snap = snapshot()
    const json = JSON.stringify(snap)
    if (json === last) return
    last = json
    api.sendTabGroupsSnapshot?.(snap)
  }
  push()
  const unsubscribe = useAppStore.subscribe(push)
  const off = api.onTabGroupsRequest?.((req: TabGroupsRequest) => {
    let result: unknown
    let error: string | undefined
    try {
      result = handle(req.op, req.args ?? {})
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    // Main reads the outcome from the snapshot, so it must land first.
    push()
    api.respondTabGroupsRequest?.(req.id, { result, error })
  })
  return () => {
    unsubscribe()
    off?.()
  }
}
