export interface Tab {
  id: string
  title: string
  url: string
  favicon: string
  comment?: string
}

export interface TabGroup {
  id: string
  name: string
  color: string
  tabs: Tab[]
  isCollapsed: boolean
}

export interface Workspace {
  id: string
  name: string
  tabGroups: TabGroup[]
  tabs: Tab[] // ungrouped tabs
  sidebarOrder?: string[] // interleaved IDs of ungrouped tabs and tab groups for display order
  /** ID of the tab that was last active in this workspace — used to restore the right tab when reopening a workspace window. */
  lastActiveTabId?: string
}

export interface Profile {
  id: string
  name: string
  partition: string
  workspaces: Workspace[]
}

export interface SearchableItem {
  type: 'profile' | 'workspace' | 'tabGroup' | 'tab'
  id: string
  name: string
  path: string
  url?: string
  comment?: string
  profileId: string
  workspaceId?: string
  tabGroupId?: string
}

/** Parsed workspace candidate from an imported bookmark file, pending user selection. */
export interface WorkspaceCandidate {
  id: string // local selection ID (not the final workspace ID)
  name: string
  path: string // breadcrumb path to help user distinguish same-named workspaces
  tabGroups: TabGroup[]
  tabs: Tab[] // ungrouped tabs
  sidebarOrder: string[] // interleaved IDs in the order seen in the HTML
}
