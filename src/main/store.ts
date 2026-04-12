import Store from 'electron-store'

const store = new Store({
  name: 'newbro-state',
  defaults: {
    state: null
  }
})

export function loadState(): unknown {
  return store.get('state')
}

export function saveState(state: unknown): void {
  store.set('state', state)
}
