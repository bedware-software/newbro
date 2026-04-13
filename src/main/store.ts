import Store from 'electron-store'

const store = new Store({
  name: 'newbro-state',
  defaults: {
    state: null,
    openWorkspaceIds: [] as string[],
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
