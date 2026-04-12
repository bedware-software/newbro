export interface Tab {
  id: string
  title: string
  url: string
  favicon: string
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
  profileId: string
  workspaceId?: string
  tabGroupId?: string
}
