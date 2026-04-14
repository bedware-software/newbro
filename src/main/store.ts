import Store from 'electron-store'

export interface OpenWindowEntry {
  profileId: string
  workspaceId: string
}

const store = new Store({
  name: 'newbro-state',
  defaults: {
    state: null,
    openWorkspaceIds: [] as string[],
    openWindows: [] as OpenWindowEntry[],
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
