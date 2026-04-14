import { create } from 'zustand'
import { produce } from 'immer'
import { v4 as uuid } from 'uuid'
import type { Profile, Workspace, TabGroup, Tab, SearchableItem, WorkspaceCandidate } from './types'
import { log } from '../lib/log'

const GROUP_COLORS = ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8', '#cba6f7', '#94e2d5', '#fab387', '#74c7ec']

/** Default URL for new tabs — updated from settings */
let defaultNewTabUrl = 'about:blank'
export function setDefaultNewTabUrl(url: string): void {
  defaultNewTabUrl = url || 'about:blank'
}

function makeTab(url?: string): Tab {
  return { id: uuid(), title: 'New Tab', url: url || defaultNewTabUrl, favicon: '' }
}

function makeTabGroup(name = 'New Group', tabs?: Tab[]): TabGroup {
  return {
    id: uuid(),
    name,
    color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
    tabs: tabs || [makeTab()],
    isCollapsed: false,
  }
}

/** Ensures workspace has sidebarOrder; creates from tabs+groups if missing. Mutates (for use inside produce). */
function ensureSidebarOrder(w: Workspace): string[] {
  if (!w.sidebarOrder) {
    w.sidebarOrder = [
      ...(w.tabs || []).map((t) => t.id),
      ...w.tabGroups.map((g) => g.id),
    ]
  }
  return w.sidebarOrder
}

/** Non-mutating version for use in render */
export function getSidebarOrder(w: Workspace): string[] {
  return w.sidebarOrder || [
    ...(w.tabs || []).map((t) => t.id),
    ...w.tabGroups.map((g) => g.id),
  ]
}

function makeWorkspace(name = 'General'): Workspace {
  const tab = makeTab()
  return { id: uuid(), name, tabGroups: [], tabs: [tab], sidebarOrder: [tab.id] }
}

function makeProfile(name = 'Default'): Profile {
  const id = uuid()
  return {
    id,
    name,
    partition: `persist:profile-${id}`,
    workspaces: [makeWorkspace()],
  }
}

function defaultState() {
  const profile = makeProfile('Work')
  const ws = profile.workspaces[0]
  const firstTab = ws.tabs?.[0] || ws.tabGroups[0]?.tabs[0]
  const firstGroup = ws.tabGroups[0] || null
  return {
    profiles: [profile],
    activeProfileId: profile.id,
    activeWorkspaceId: ws.id,
    activeTabGroupId: firstGroup?.id || null,
    activeTabId: firstTab?.id || null,
  }
}

export interface AppState {
  profiles: Profile[]
  activeProfileId: string | null
  activeWorkspaceId: string | null
  activeTabGroupId: string | null
  activeTabId: string | null

  hydrate: (data: unknown) => void

  // Profile actions
  addProfile: (name: string) => Profile
  removeProfile: (id: string) => void
  renameProfile: (id: string, name: string) => void
  setActiveProfile: (id: string) => void

  // Workspace actions
  addWorkspace: (profileId: string, name: string) => Workspace
  removeWorkspace: (id: string) => void
  renameWorkspace: (id: string, name: string) => void
  setActiveWorkspace: (id: string) => void
  moveWorkspace: (workspaceId: string, targetIndex: number) => void

  // Tab group actions
  addTabGroup: (workspaceId: string, name: string) => void
  removeTabGroup: (id: string) => void
  renameTabGroup: (id: string, name: string) => void
  toggleTabGroupCollapse: (id: string) => void

  // Tab actions
  addTab: (tabGroupId: string, url?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTabUrl: (id: string, url: string) => void
  updateTabTitle: (id: string, title: string) => void
  updateTabFavicon: (id: string, favicon: string) => void
  setTabComment: (id: string, comment: string) => void

  // Ungrouped tab actions
  addUngroupedTab: (workspaceId: string, url?: string) => void
  ungroupTab: (tabId: string) => void
  ungroupAll: (groupId: string) => void
  closeGroup: (groupId: string) => void

  // Multi-tab operations
  moveTab: (tabId: string, targetGroupId: string | null, targetIndex: number) => void
  moveTabs: (tabIds: string[], targetGroupId: string | null, targetIndex: number) => void
  moveTabGroup: (groupId: string, targetIndex: number) => void
  moveTabToGroup: (tabId: string, targetGroupId: string) => void
  moveTabsToNewGroup: (tabIds: string[], groupName: string) => void

  // Navigate to a specific item
  navigateTo: (profileId: string, workspaceId?: string, tabGroupId?: string, tabId?: string) => void

  // Search helpers
  getAllSearchableItems: () => SearchableItem[]

  // Import
  importSelectedWorkspaces: (profileId: string, candidates: WorkspaceCandidate[]) => Workspace[]

  // Helpers
  getActiveProfile: () => Profile | undefined
  getActiveWorkspace: () => Workspace | undefined
  getActiveTab: () => Tab | undefined
  getActivePartition: () => string | undefined
  findProfileForTab: (tabId: string) => Profile | undefined
}

/**
 * Parse a Netscape bookmark HTML file and extract all workspace candidates.
 *
 * A folder qualifies as a workspace if it contains at least one tab or tab
 * group AND has at most one level of nested folders (folders whose only
 * children are links). Folders with deeper nesting are descended into so we
 * can still find valid workspaces inside them, but the parent itself is not
 * offered as a candidate (it would bring in the wrong structure).
 */
export function findWorkspaceCandidates(html: string): WorkspaceCandidate[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const topDl = doc.querySelector('body > DL') || doc.querySelector('DL')
  if (!topDl) return []

  const candidates: WorkspaceCandidate[] = []

  /** A folder is a <DT> that directly contains an <H3> and a <DL>. */
  const getFolderName = (dt: Element): string =>
    dt.querySelector(':scope > H3')?.textContent?.trim() || 'Folder'
  const getFolderDl = (dt: Element): Element | null =>
    dt.querySelector(':scope > DL')

  /** Extract a link <DT><A> into a Tab. */
  const tabFromAnchor = (a: Element): Tab => ({
    id: uuid(),
    title: a.textContent?.trim() || 'Untitled',
    url: a.getAttribute('HREF') || 'about:blank',
    favicon: a.getAttribute('ICON') || '',
  })

  /** True if this folder has no subfolders (its children are all links or empty). */
  const isFlatTabGroupFolder = (folderDt: Element): boolean => {
    const dl = getFolderDl(folderDt)
    if (!dl) return true // no DL means no subfolders — treat as flat/empty
    for (const c of Array.from(dl.children).filter((el) => el.tagName === 'DT')) {
      if (c.querySelector(':scope > H3')) return false // contains a subfolder
    }
    return true
  }

  /**
   * Attempt to extract a workspace from the given folder. Returns null if
   * the folder has deeper than one level of nesting, or is empty. When it
   * does return null, caller should recurse into subfolders.
   */
  const buildWorkspaceFromFolder = (
    folderDt: Element,
    path: string,
  ): WorkspaceCandidate | null => {
    const dl = getFolderDl(folderDt)
    if (!dl) return null

    const ungroupedTabs: Tab[] = []
    const tabGroups: TabGroup[] = []
    const sidebarOrder: string[] = []

    for (const dt of Array.from(dl.children).filter((el) => el.tagName === 'DT')) {
      const a = dt.querySelector(':scope > A')
      const h3 = dt.querySelector(':scope > H3')

      if (a && !h3) {
        const tab = tabFromAnchor(a)
        ungroupedTabs.push(tab)
        sidebarOrder.push(tab.id)
        continue
      }
      if (!h3) continue

      // Subfolder: must be flat (no further nesting) for this folder to
      // qualify as a workspace.
      if (!isFlatTabGroupFolder(dt)) return null

      const groupName = getFolderName(dt)
      const groupDl = getFolderDl(dt)
      const groupTabs: Tab[] = []
      if (groupDl) {
        for (const gDt of Array.from(groupDl.children).filter((el) => el.tagName === 'DT')) {
          const gA = gDt.querySelector(':scope > A')
          if (gA) groupTabs.push(tabFromAnchor(gA))
        }
      }
      if (groupTabs.length > 0) {
        const tg = makeTabGroup(groupName, groupTabs)
        tg.isCollapsed = true
        tabGroups.push(tg)
        sidebarOrder.push(tg.id)
      }
    }

    if (ungroupedTabs.length === 0 && tabGroups.length === 0) return null

    const name = getFolderName(folderDt)
    return {
      id: uuid(),
      name,
      path: path ? `${path} / ${name}` : name,
      tabGroups,
      tabs: ungroupedTabs,
      sidebarOrder,
    }
  }

  /** Recurse: try this folder; if not a valid workspace, descend. */
  const visitFolder = (folderDt: Element, parentPath: string): void => {
    const candidate = buildWorkspaceFromFolder(folderDt, parentPath)
    if (candidate) {
      candidates.push(candidate)
      return
    }
    // Not a valid workspace here — walk into any subfolders.
    const dl = getFolderDl(folderDt)
    if (!dl) return
    const name = getFolderName(folderDt)
    const nextPath = parentPath ? `${parentPath} / ${name}` : name
    for (const dt of Array.from(dl.children).filter((el) => el.tagName === 'DT')) {
      if (dt.querySelector(':scope > H3')) visitFolder(dt, nextPath)
    }
  }

  for (const dt of Array.from(topDl.children).filter((el) => el.tagName === 'DT')) {
    if (dt.querySelector(':scope > H3')) visitFolder(dt, '')
  }

  return candidates
}

export const useAppStore = create<AppState>((set, get) => ({
  ...defaultState(),

  hydrate: (data: unknown) => {
    const d = data as Partial<AppState>
    log.state('hydrate called', { hasData: !!d, profileCount: d?.profiles?.length })
    if (d && d.profiles && d.profiles.length > 0) {
      // Ensure all workspaces have a tabs array (migration from old state)
      for (const p of d.profiles) {
        for (const w of p.workspaces) {
          if (!w.tabs) w.tabs = []
        }
      }
      const state = {
        profiles: d.profiles,
        activeProfileId: d.activeProfileId || d.profiles[0].id,
        activeWorkspaceId: d.activeWorkspaceId || d.profiles[0].workspaces[0]?.id || null,
        activeTabGroupId: d.activeTabGroupId || null,
        activeTabId: d.activeTabId || null,
      }
      log.state('hydrate setting', { activeProfileId: state.activeProfileId, activeWorkspaceId: state.activeWorkspaceId })
      set(state)
    }
  },

  // ── Profile ──
  addProfile: (name) => {
    const profile = makeProfile(name)
    set(produce((s: AppState) => {
      s.profiles.push(profile)
    }))
    return profile
  },

  removeProfile: (id) => set(produce((s: AppState) => {
    s.profiles = s.profiles.filter((p) => p.id !== id)
    if (s.activeProfileId === id) {
      const next = s.profiles[0]
      s.activeProfileId = next?.id || null
      s.activeWorkspaceId = next?.workspaces[0]?.id || null
      s.activeTabGroupId = next?.workspaces[0]?.tabGroups[0]?.id || null
      s.activeTabId = next?.workspaces[0]?.tabGroups[0]?.tabs[0]?.id || null
    }
  })),

  renameProfile: (id, name) => set(produce((s: AppState) => {
    const p = s.profiles.find((p) => p.id === id)
    if (p) p.name = name
  })),

  setActiveProfile: (id) => set(produce((s: AppState) => {
    s.activeProfileId = id
    const p = s.profiles.find((p) => p.id === id)
    if (p) {
      s.activeWorkspaceId = p.workspaces[0]?.id || null
      const tg = p.workspaces[0]?.tabGroups[0]
      s.activeTabGroupId = tg?.id || null
      s.activeTabId = tg?.tabs[0]?.id || null
    }
  })),

  // ── Workspace ──
  addWorkspace: (profileId, name) => {
    const ws = makeWorkspace(name)
    set(produce((s: AppState) => {
      const p = s.profiles.find((p) => p.id === profileId)
      if (p) p.workspaces.push(ws)
    }))
    return ws
  },

  removeWorkspace: (id) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      const idx = p.workspaces.findIndex((w) => w.id === id)
      if (idx !== -1) {
        p.workspaces.splice(idx, 1)
        if (s.activeWorkspaceId === id) {
          const next = p.workspaces[0]
          s.activeWorkspaceId = next?.id || null
          s.activeTabGroupId = next?.tabGroups[0]?.id || null
          s.activeTabId = next?.tabGroups[0]?.tabs[0]?.id || null
        }
        break
      }
    }
  })),

  renameWorkspace: (id, name) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      const w = p.workspaces.find((w) => w.id === id)
      if (w) { w.name = name; break }
    }
  })),

  setActiveWorkspace: (id) => set(produce((s: AppState) => {
    s.activeWorkspaceId = id
    for (const p of s.profiles) {
      const w = p.workspaces.find((w) => w.id === id)
      if (w) {
        s.activeProfileId = p.id
        const tg = w.tabGroups[0]
        s.activeTabGroupId = tg?.id || null
        s.activeTabId = tg?.tabs[0]?.id || null
        break
      }
    }
  })),

  moveWorkspace: (workspaceId, targetIndex) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      const sourceIndex = p.workspaces.findIndex((w) => w.id === workspaceId)
      if (sourceIndex === -1) continue
      const [workspace] = p.workspaces.splice(sourceIndex, 1)
      if (!workspace) return
      let idx = Math.max(0, Math.min(targetIndex, p.workspaces.length))
      if (sourceIndex < idx) idx -= 1
      p.workspaces.splice(idx, 0, workspace)
      return
    }
  })),

  // ── Tab Group ──
  addTabGroup: (workspaceId, name) => {
    const tg = makeTabGroup(name)
    set(produce((s: AppState) => {
      for (const p of s.profiles) {
        const w = p.workspaces.find((w) => w.id === workspaceId)
        if (w) {
          w.tabGroups.push(tg)
          ensureSidebarOrder(w).push(tg.id)
          s.activeTabGroupId = tg.id
          s.activeTabId = tg.tabs[0]?.id || null
          break
        }
      }
    }))
  },

  removeTabGroup: (id) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const idx = w.tabGroups.findIndex((g) => g.id === id)
        if (idx !== -1) {
          w.tabGroups.splice(idx, 1)
          const order = ensureSidebarOrder(w)
          const oi = order.indexOf(id)
          if (oi !== -1) order.splice(oi, 1)
          if (s.activeTabGroupId === id) {
            const next = w.tabGroups[0]
            s.activeTabGroupId = next?.id || null
            s.activeTabId = next?.tabs[0]?.id || null
          }
          return
        }
      }
    }
  })),

  renameTabGroup: (id, name) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const g = w.tabGroups.find((g) => g.id === id)
        if (g) { g.name = name; return }
      }
    }
  })),

  toggleTabGroupCollapse: (id) => {
    log.action('toggleTabGroupCollapse', id)
    set(produce((s: AppState) => {
      for (const p of s.profiles) {
        for (const w of p.workspaces) {
          const g = w.tabGroups.find((g) => g.id === id)
          if (g) {
            // Prevent collapsing if the active tab is inside this group
            if (!g.isCollapsed && g.tabs.some((t) => t.id === s.activeTabId)) return
            log.debug('collapse toggle', g.name, g.isCollapsed, '->', !g.isCollapsed)
            g.isCollapsed = !g.isCollapsed
            return
          }
        }
      }
      log.warn('toggleTabGroupCollapse: group not found', id)
    }))
  },

  // ── Tab ──
  addTab: (tabGroupId, url) => {
    const tab = makeTab(url)
    log.action('addTab', { tabGroupId, url, tabId: tab.id })
    set(produce((s: AppState) => {
      for (const p of s.profiles) {
        for (const w of p.workspaces) {
          const g = w.tabGroups.find((g) => g.id === tabGroupId)
          if (g) {
            const activeIdx = g.tabs.findIndex((t) => t.id === s.activeTabId)
            if (activeIdx !== -1) {
              g.tabs.splice(activeIdx + 1, 0, tab)
            } else {
              g.tabs.push(tab)
            }
            g.isCollapsed = false // ensure group is expanded so new tab is visible
            s.activeTabId = tab.id
            s.activeTabGroupId = tabGroupId
            return
          }
        }
      }
    }))
  },

  closeTab: (id) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        // Check ungrouped tabs
        if (w.tabs) {
          const uIdx = w.tabs.findIndex((t) => t.id === id)
          if (uIdx !== -1) {
            w.tabs.splice(uIdx, 1)
            const order = ensureSidebarOrder(w)
            const oi = order.indexOf(id)
            if (oi !== -1) order.splice(oi, 1)
            if (s.activeTabId === id) {
              const next = w.tabs[uIdx] || w.tabs[uIdx - 1]
              s.activeTabId = next?.id || w.tabGroups[0]?.tabs[0]?.id || null
            }
            return
          }
        }
        // Check grouped tabs
        for (const g of w.tabGroups) {
          const idx = g.tabs.findIndex((t) => t.id === id)
          if (idx !== -1) {
            g.tabs.splice(idx, 1)
            if (s.activeTabId === id) {
              const next = g.tabs[idx] || g.tabs[idx - 1]
              s.activeTabId = next?.id || null
            }
            // Remove empty groups
            if (g.tabs.length === 0) {
              const gIdx = w.tabGroups.indexOf(g)
              if (gIdx !== -1) w.tabGroups.splice(gIdx, 1)
              const order = ensureSidebarOrder(w)
              const oi = order.indexOf(g.id)
              if (oi !== -1) order.splice(oi, 1)
            }
            return
          }
        }
      }
    }
  })),

  setActiveTab: (id) => set(produce((s: AppState) => {
    s.activeTabId = id
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        // Check ungrouped tabs
        if (w.tabs?.some((t) => t.id === id)) {
          s.activeProfileId = p.id
          s.activeWorkspaceId = w.id
          s.activeTabGroupId = null
          return
        }
        for (const g of w.tabGroups) {
          if (g.tabs.some((t) => t.id === id)) {
            s.activeProfileId = p.id
            s.activeWorkspaceId = w.id
            s.activeTabGroupId = g.id
            g.isCollapsed = false // expand containing group so the active tab is visible in the sidebar
            return
          }
        }
      }
    }
  })),

  updateTabUrl: (id, url) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const ut = w.tabs?.find((t) => t.id === id)
        if (ut) { ut.url = url; return }
        for (const g of w.tabGroups) {
          const t = g.tabs.find((t) => t.id === id)
          if (t) { t.url = url; return }
        }
      }
    }
  })),

  updateTabTitle: (id, title) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const ut = w.tabs?.find((t) => t.id === id)
        if (ut) { ut.title = title; return }
        for (const g of w.tabGroups) {
          const t = g.tabs.find((t) => t.id === id)
          if (t) { t.title = title; return }
        }
      }
    }
  })),

  updateTabFavicon: (id, favicon) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const ut = w.tabs?.find((t) => t.id === id)
        if (ut) { ut.favicon = favicon; return }
        for (const g of w.tabGroups) {
          const t = g.tabs.find((t) => t.id === id)
          if (t) { t.favicon = favicon; return }
        }
      }
    }
  })),

  setTabComment: (id, comment) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const ut = w.tabs?.find((t) => t.id === id)
        if (ut) { ut.comment = comment || undefined; return }
        for (const g of w.tabGroups) {
          const t = g.tabs.find((t) => t.id === id)
          if (t) { t.comment = comment || undefined; return }
        }
      }
    }
  })),

  // ── Ungrouped tabs ──
  addUngroupedTab: (workspaceId, url) => {
    const tab = makeTab(url)
    log.action('addUngroupedTab', { workspaceId, url, tabId: tab.id })
    set(produce((s: AppState) => {
      for (const p of s.profiles) {
        const w = p.workspaces.find((w) => w.id === workspaceId)
        if (w) {
          if (!w.tabs) w.tabs = []
          w.tabs.push(tab)
          const order = ensureSidebarOrder(w)
          const activeIdx = s.activeTabId ? order.indexOf(s.activeTabId) : -1
          if (activeIdx !== -1) {
            order.splice(activeIdx + 1, 0, tab.id)
          } else {
            order.push(tab.id)
          }
          s.activeTabId = tab.id
          s.activeTabGroupId = null
          return
        }
      }
    }))
  },

  ungroupTab: (tabId) => set(produce((s: AppState) => {
    let tab: Tab | undefined
    let targetWorkspace: Workspace | undefined
    let sourceGroupId: string | undefined
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        for (const g of w.tabGroups) {
          const idx = g.tabs.findIndex((t) => t.id === tabId)
          if (idx !== -1) {
            tab = { ...g.tabs[idx] }
            sourceGroupId = g.id
            g.tabs.splice(idx, 1)
            targetWorkspace = w
            break
          }
        }
        if (tab) break
      }
      if (tab) break
    }
    if (!tab || !targetWorkspace) return
    if (!targetWorkspace.tabs) targetWorkspace.tabs = []
    targetWorkspace.tabs.push(tab)
    // Insert in sidebarOrder right after the source group
    const order = ensureSidebarOrder(targetWorkspace)
    if (sourceGroupId) {
      const gi = order.indexOf(sourceGroupId)
      if (gi !== -1) order.splice(gi + 1, 0, tab.id)
      else order.push(tab.id)
    } else {
      order.push(tab.id)
    }
    if (s.activeTabId === tabId) {
      s.activeTabGroupId = null
    }
    // Remove empty groups
    const removedGroupIds = new Set<string>()
    targetWorkspace.tabGroups = targetWorkspace.tabGroups.filter((g) => {
      if (g.tabs.length > 0) return true
      removedGroupIds.add(g.id)
      return false
    })
    if (removedGroupIds.size > 0) {
      targetWorkspace.sidebarOrder = order.filter((id) => !removedGroupIds.has(id))
    }
  })),

  ungroupAll: (groupId) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const idx = w.tabGroups.findIndex((g) => g.id === groupId)
        if (idx !== -1) {
          const group = w.tabGroups[idx]
          if (!w.tabs) w.tabs = []
          const tabCopies = group.tabs.map((t) => ({ ...t }))
          w.tabs.push(...tabCopies)
          w.tabGroups.splice(idx, 1)
          // Replace group ID with individual tab IDs in sidebarOrder
          const order = ensureSidebarOrder(w)
          const gi = order.indexOf(groupId)
          if (gi !== -1) {
            order.splice(gi, 1, ...tabCopies.map((t) => t.id))
          } else {
            order.push(...tabCopies.map((t) => t.id))
          }
          if (s.activeTabGroupId === groupId) {
            s.activeTabGroupId = null
          }
          return
        }
      }
    }
  })),

  closeGroup: (groupId) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const idx = w.tabGroups.findIndex((g) => g.id === groupId)
        if (idx !== -1) {
          const group = w.tabGroups[idx]
          const closedTabIds = new Set(group.tabs.map((t) => t.id))
          w.tabGroups.splice(idx, 1)
          const order = ensureSidebarOrder(w)
          const oi = order.indexOf(groupId)
          if (oi !== -1) order.splice(oi, 1)
          if (s.activeTabGroupId === groupId || closedTabIds.has(s.activeTabId || '')) {
            const nextGroup = w.tabGroups[0]
            s.activeTabGroupId = nextGroup?.id || null
            s.activeTabId = nextGroup?.tabs[0]?.id || w.tabs?.[0]?.id || null
          }
          return
        }
      }
    }
  })),

  // ── Multi-tab operations ──
  moveTab: (tabId, targetGroupId, targetIndex) => {
    get().moveTabs([tabId], targetGroupId, targetIndex)
  },

  moveTabs: (tabIds, targetGroupId, targetIndex) => set(produce((s: AppState) => {
    const orderedTabIds = [...new Set(tabIds)]
    if (orderedTabIds.length === 0) return

    interface LocatedTab {
      id: string
      tab: Tab
      workspace: Workspace
      groupId: string | null
      index: number
    }

    const locatedTabs: LocatedTab[] = []

    for (const id of orderedTabIds) {
      let found = false
      for (const p of s.profiles) {
        for (const w of p.workspaces) {
          const ungroupedIdx = w.tabs?.findIndex((t) => t.id === id) ?? -1
          if (ungroupedIdx !== -1 && w.tabs) {
            locatedTabs.push({
              id,
              tab: { ...w.tabs[ungroupedIdx] },
              workspace: w,
              groupId: null,
              index: ungroupedIdx,
            })
            found = true
            break
          }

          for (const g of w.tabGroups) {
            const groupedIdx = g.tabs.findIndex((t) => t.id === id)
            if (groupedIdx !== -1) {
              locatedTabs.push({
                id,
                tab: { ...g.tabs[groupedIdx] },
                workspace: w,
                groupId: g.id,
                index: groupedIdx,
              })
              found = true
              break
            }
          }

          if (found) break
        }
        if (found) break
      }
    }

    if (locatedTabs.length === 0) return

    let targetWorkspace = locatedTabs[0].workspace
    if (targetGroupId) {
      let resolvedWorkspace: Workspace | undefined
      for (const p of s.profiles) {
        for (const w of p.workspaces) {
          if (w.tabGroups.some((g) => g.id === targetGroupId)) {
            resolvedWorkspace = w
            break
          }
        }
        if (resolvedWorkspace) break
      }
      if (resolvedWorkspace) targetWorkspace = resolvedWorkspace
    }

    const containerMap = new Map<string, LocatedTab[]>()
    for (const located of locatedTabs) {
      const key = `${located.workspace.id}:${located.groupId || '__ungrouped__'}`
      const list = containerMap.get(key) || []
      list.push(located)
      containerMap.set(key, list)
    }

    for (const entries of containerMap.values()) {
      entries.sort((a, b) => b.index - a.index)
      const sample = entries[0]
      if (sample.groupId) {
        const group = sample.workspace.tabGroups.find((g) => g.id === sample.groupId)
        if (!group) continue
        for (const entry of entries) {
          const idx = group.tabs.findIndex((t) => t.id === entry.id)
          if (idx !== -1) group.tabs.splice(idx, 1)
        }
      } else {
        const tabs = sample.workspace.tabs || []
        for (const entry of entries) {
          const idx = tabs.findIndex((t) => t.id === entry.id)
          if (idx !== -1) tabs.splice(idx, 1)
        }
      }
    }

    let effectiveTargetGroupId: string | null = targetGroupId
    let targetTabs: Tab[]

    if (effectiveTargetGroupId) {
      const targetGroup = targetWorkspace.tabGroups.find((g) => g.id === effectiveTargetGroupId)
      if (targetGroup) {
        targetGroup.isCollapsed = false
        targetTabs = targetGroup.tabs
      } else {
        effectiveTargetGroupId = null
        if (!targetWorkspace.tabs) targetWorkspace.tabs = []
        targetTabs = targetWorkspace.tabs
      }
    } else {
      if (!targetWorkspace.tabs) targetWorkspace.tabs = []
      targetTabs = targetWorkspace.tabs
    }

    const removedBeforeTarget = locatedTabs.filter((entry) =>
      entry.workspace.id === targetWorkspace.id &&
      entry.groupId === effectiveTargetGroupId &&
      entry.index < targetIndex,
    ).length

    let insertIndex = targetIndex - removedBeforeTarget
    insertIndex = Math.max(0, Math.min(insertIndex, targetTabs.length))

    const orderedTabs = orderedTabIds
      .map((id) => locatedTabs.find((entry) => entry.id === id)?.tab)
      .filter((tab): tab is Tab => !!tab)
      .map((tab) => ({ ...tab }))

    targetTabs.splice(insertIndex, 0, ...orderedTabs)

    const movedIds = new Set(orderedTabIds)
    if (s.activeTabId && movedIds.has(s.activeTabId)) {
      s.activeTabGroupId = effectiveTargetGroupId
    }

    // Update sidebarOrder
    const order = ensureSidebarOrder(targetWorkspace)
    if (!effectiveTargetGroupId) {
      // Moving to ungrouped: remove from sidebarOrder, then insert at targetIndex
      let removedBefore = 0
      for (let i = 0; i < order.length && i < targetIndex; i++) {
        if (movedIds.has(order[i])) removedBefore++
      }
      const newOrder = order.filter((id) => !movedIds.has(id))
      const adjIdx = Math.max(0, Math.min(targetIndex - removedBefore, newOrder.length))
      newOrder.splice(adjIdx, 0, ...orderedTabIds)
      targetWorkspace.sidebarOrder = newOrder
    } else {
      // Moving into a group: remove tab IDs from sidebarOrder
      targetWorkspace.sidebarOrder = order.filter((id) => !movedIds.has(id))
    }

    // Clean up empty groups
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const removedGroupIds = new Set<string>()
        w.tabGroups = w.tabGroups.filter((g) => {
          if (g.tabs.length > 0) return true
          removedGroupIds.add(g.id)
          return false
        })
        if (removedGroupIds.size > 0 && w.sidebarOrder) {
          w.sidebarOrder = w.sidebarOrder.filter((id) => !removedGroupIds.has(id))
        }
      }
    }
  })),

  moveTabGroup: (groupId, targetIndex) => set(produce((s: AppState) => {
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        if (!w.tabGroups.some((g) => g.id === groupId)) continue
        // Reorder in sidebarOrder (tabGroups array order no longer matters for display)
        const order = ensureSidebarOrder(w)
        const sourceIndex = order.indexOf(groupId)
        if (sourceIndex === -1) return
        order.splice(sourceIndex, 1)
        let idx = targetIndex
        if (sourceIndex < idx) idx--
        idx = Math.max(0, Math.min(idx, order.length))
        order.splice(idx, 0, groupId)
        return
      }
    }
  })),

  moveTabToGroup: (tabId, targetGroupId) => {
    const { profiles, moveTab } = get()
    let targetLength = 0
    for (const p of profiles) {
      for (const w of p.workspaces) {
        const g = w.tabGroups.find((tg) => tg.id === targetGroupId)
        if (g) {
          targetLength = g.tabs.length
          break
        }
      }
    }
    moveTab(tabId, targetGroupId, targetLength)
  },

  moveTabsToNewGroup: (tabIds, groupName) => set(produce((s: AppState) => {
    const tabs: Tab[] = []
    let targetWorkspace: Workspace | undefined

    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        if (w.tabs) {
          const toRemove: number[] = []
          for (let i = 0; i < w.tabs.length; i++) {
            if (tabIds.includes(w.tabs[i].id)) {
              tabs.push({ ...w.tabs[i] })
              toRemove.push(i)
              if (!targetWorkspace) targetWorkspace = w
            }
          }
          for (let i = toRemove.length - 1; i >= 0; i--) {
            w.tabs.splice(toRemove[i], 1)
          }
        }
        for (const g of w.tabGroups) {
          const toRemove: number[] = []
          for (let i = 0; i < g.tabs.length; i++) {
            if (tabIds.includes(g.tabs[i].id)) {
              tabs.push({ ...g.tabs[i] })
              toRemove.push(i)
              if (!targetWorkspace) targetWorkspace = w
            }
          }
          for (let i = toRemove.length - 1; i >= 0; i--) {
            g.tabs.splice(toRemove[i], 1)
          }
        }
      }
    }

    if (tabs.length === 0 || !targetWorkspace) return

    const newGroup = makeTabGroup(groupName, tabs)
    targetWorkspace.tabGroups.push(newGroup)
    s.activeTabGroupId = newGroup.id
    s.activeTabId = tabs[0].id

    // Update sidebarOrder: replace first moved tab's position with new group
    const order = ensureSidebarOrder(targetWorkspace)
    const tabIdSet = new Set(tabIds)
    let insertPos = -1
    const newOrder: string[] = []
    for (const id of order) {
      if (tabIdSet.has(id)) {
        if (insertPos === -1) insertPos = newOrder.length
      } else {
        newOrder.push(id)
      }
    }
    if (insertPos === -1) insertPos = newOrder.length
    newOrder.splice(insertPos, 0, newGroup.id)
    targetWorkspace.sidebarOrder = newOrder

    // Clean up empty groups
    for (const p of s.profiles) {
      for (const w of p.workspaces) {
        const removedGroupIds = new Set<string>()
        w.tabGroups = w.tabGroups.filter((g) => {
          if (g.tabs.length > 0) return true
          removedGroupIds.add(g.id)
          return false
        })
        if (removedGroupIds.size > 0 && w.sidebarOrder) {
          w.sidebarOrder = w.sidebarOrder.filter((id) => !removedGroupIds.has(id))
        }
      }
    }
  })),

  importSelectedWorkspaces: (profileId, candidates) => {
    const created: Workspace[] = candidates.map((c) => ({
      id: uuid(),
      name: c.name,
      tabGroups: c.tabGroups,
      tabs: c.tabs,
      sidebarOrder: c.sidebarOrder,
    }))
    set(produce((s: AppState) => {
      const p = s.profiles.find((p) => p.id === profileId)
      if (p) p.workspaces.push(...created)
    }))
    return created
  },

  navigateTo: (profileId, workspaceId, tabGroupId, tabId) => set(produce((s: AppState) => {
    s.activeProfileId = profileId
    const p = s.profiles.find((p) => p.id === profileId)
    if (!p) return
    s.activeWorkspaceId = workspaceId || p.workspaces[0]?.id || null
    const w = p.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!w) return
    s.activeTabGroupId = tabGroupId || w.tabGroups[0]?.id || null
    const g = w.tabGroups.find((g) => g.id === s.activeTabGroupId)
    if (!g) return
    s.activeTabId = tabId || g.tabs[0]?.id || null
  })),

  getAllSearchableItems: () => {
    const { profiles } = get()
    const items: SearchableItem[] = []
    for (const p of profiles) {
      items.push({ type: 'profile', id: p.id, name: p.name, path: p.name, profileId: p.id })
      for (const w of p.workspaces) {
        items.push({ type: 'workspace', id: w.id, name: w.name, path: `${p.name} > ${w.name}`, profileId: p.id, workspaceId: w.id })
        for (const t of (w.tabs || [])) {
          items.push({ type: 'tab', id: t.id, name: t.title, url: t.url, comment: t.comment, path: `${p.name} > ${w.name} > ${t.title}`, profileId: p.id, workspaceId: w.id })
        }
        for (const g of w.tabGroups) {
          items.push({ type: 'tabGroup', id: g.id, name: g.name, path: `${p.name} > ${w.name} > ${g.name}`, profileId: p.id, workspaceId: w.id, tabGroupId: g.id })
          for (const t of g.tabs) {
            items.push({ type: 'tab', id: t.id, name: t.title, url: t.url, comment: t.comment, path: `${p.name} > ${w.name} > ${g.name} > ${t.title}`, profileId: p.id, workspaceId: w.id, tabGroupId: g.id })
          }
        }
      }
    }
    return items
  },

  getActiveProfile: () => {
    const { profiles, activeProfileId } = get()
    return profiles.find((p) => p.id === activeProfileId)
  },

  getActiveWorkspace: () => {
    const s = get()
    const p = s.getActiveProfile()
    return p?.workspaces.find((w) => w.id === s.activeWorkspaceId)
  },

  getActiveTab: () => {
    const s = get()
    const w = s.getActiveWorkspace()
    if (!w) return undefined
    const ut = w.tabs?.find((t) => t.id === s.activeTabId)
    if (ut) return ut
    for (const g of w.tabGroups) {
      const t = g.tabs.find((t) => t.id === s.activeTabId)
      if (t) return t
    }
    return undefined
  },

  getActivePartition: () => {
    const s = get()
    return s.getActiveProfile()?.partition
  },

  findProfileForTab: (tabId) => {
    const { profiles } = get()
    for (const p of profiles) {
      for (const w of p.workspaces) {
        if (w.tabs?.some((t) => t.id === tabId)) return p
        for (const g of w.tabGroups) {
          if (g.tabs.some((t) => t.id === tabId)) return p
        }
      }
    }
    return undefined
  },
}))

// ── Persistence: debounced save with change detection ──
function getSerializableState() {
  const { profiles, activeProfileId, activeWorkspaceId, activeTabGroupId, activeTabId } = useAppStore.getState()
  return { profiles, activeProfileId, activeWorkspaceId, activeTabGroupId, activeTabId }
}

/** When true, suppress the save subscriber (we're applying a remote update) */
let suppressSave = false

/** Call fn() without triggering a save+broadcast */
export function withoutSave(fn: () => void): void {
  suppressSave = true
  try { fn() } finally { suppressSave = false }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null
let lastSavedJson = ''

useAppStore.subscribe(() => {
  if (suppressSave) return
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    const data = getSerializableState()
    const json = JSON.stringify(data)
    if (json === lastSavedJson) return // no actual change — skip save
    lastSavedJson = json
    log.ipc('saveState (debounced)', { profileCount: data.profiles.length })
    window.electronAPI?.saveState(data)
  }, 300)
})

/** Immediately save state — call before opening new windows */
export function saveStateNow(): Promise<void> {
  if (saveTimeout) clearTimeout(saveTimeout)
  const data = getSerializableState()
  const json = JSON.stringify(data)
  lastSavedJson = json
  log.ipc('saveStateNow (sync)', { profileCount: data.profiles.length })
  return window.electronAPI?.saveState(data) ?? Promise.resolve()
}
