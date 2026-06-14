import Store from 'electron-store'

export interface OpenWindowEntry {
  profileId: string
  workspaceId: string
}

export interface WorkspaceBounds {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

const store = new Store({
  name: 'newbro-state',
  defaults: {
    state: null,
    openWorkspaceIds: [] as string[],
    openWindows: [] as OpenWindowEntry[],
    workspaceBounds: {} as Record<string, WorkspaceBounds>,
    lastUsedWorkspaceByProfile: {} as Record<string, string>,
  }
})

export function loadState(): unknown {
  return store.get('state')
}

export function saveState(state: unknown): void {
  store.set('state', state)
}

export function loadOpenWorkspaceIds(): string[] {
  return (store.get('openWorkspaceIds') as string[]) || []
}

export function saveOpenWorkspaceIds(ids: string[]): void {
  store.set('openWorkspaceIds', ids)
}

export function loadOpenWindows(): OpenWindowEntry[] {
  return (store.get('openWindows') as OpenWindowEntry[]) || []
}

export function saveOpenWindows(entries: OpenWindowEntry[]): void {
  store.set('openWindows', entries)
}

export function loadLastUsedWorkspace(profileId: string): string | null {
  if (!profileId) return null
  const all = (store.get('lastUsedWorkspaceByProfile') as Record<string, string>) || {}
  return all[profileId] ?? null
}

export function saveLastUsedWorkspace(profileId: string, workspaceId: string): void {
  if (!profileId || !workspaceId) return
  const all = (store.get('lastUsedWorkspaceByProfile') as Record<string, string>) || {}
  // Focus events repeat for the same window; skip the disk write when unchanged.
  if (all[profileId] === workspaceId) return
  all[profileId] = workspaceId
  store.set('lastUsedWorkspaceByProfile', all)
}

export function loadWorkspaceBounds(workspaceId: string): WorkspaceBounds | null {
  if (!workspaceId) return null
  const all = (store.get('workspaceBounds') as Record<string, WorkspaceBounds>) || {}
  return all[workspaceId] ?? null
}

export function saveWorkspaceBounds(workspaceId: string, bounds: WorkspaceBounds): void {
  if (!workspaceId) return
  const all = (store.get('workspaceBounds') as Record<string, WorkspaceBounds>) || {}
  all[workspaceId] = bounds
  store.set('workspaceBounds', all)
}
