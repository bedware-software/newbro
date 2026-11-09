// Bangs page (vimperium://bangs) — the bang table behind `!w vim` in the address
// bar (src/shared/bangs.ts), and the search engine plain queries go to. An
// internal page like Downloads (lib/internal-pages.ts): WebviewPanel draws it
// over the page area, and it takes the same keys — see KEY_HELP (`?`). In
// Vim mode it's COMMAND's and the window's keymap runs on it
// (lib/internal-page-keys.ts): j/k move, dd deletes, u undoes, and every key
// the page has no use for — od, Tab, Ctrl+J/K, ; — is the window's.
//
// The table lives in main (src/main/bangs-store.ts); we mirror its
// broadcasts and save the whole table on every change. The engine and the
// bangs switch are Settings (settings-store.ts) — read fresh from main before
// each change so nothing else in Settings is overwritten.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Zap, Search, X, Keyboard, Plus, Pencil, Trash2, RotateCcw, Power, PowerOff, Copy,
  ArrowDownWideNarrow, ArrowUpNarrowWide,
} from 'lucide-react'
import {
  BANG_CATEGORIES, DEFAULT_BANGS, bangProblem, expandBang, normalizeTrigger, type Bang,
} from '../../../shared/bangs'
import { SEARCH_ENGINES, searchEngineProblem } from '../../../shared/search-engines'
import { keepsChromeKeyboard } from '../lib/vim-mode'
import {
  CONTEXT_MENU_KEYS, LIST_MOVES, cmd, helpKeys, titleWithKey, useInternalPageKeys, windowKeysNote,
  type ListMove, type PageKeyRunner, type PageKeyTable,
} from '../lib/internal-page-keys'
import { log } from '../lib/log'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'
import { Hint, HintBar, KeyCap } from './KeyHints'

type SortKey = 'category' | 'trigger' | 'name'
type SortDir = 'asc' | 'desc'
interface SortState {
  key: SortKey
  dir: SortDir
}

const SORT_KEYS: SortKey[] = ['category', 'trigger', 'name']
const SORT_LABELS: Record<SortKey, string> = { category: 'Category', trigger: 'Trigger', name: 'Name' }
const SORT_STORAGE_KEY = 'vimperium-bangs-sort'

// How long the first R of "R R" (reset to defaults) waits for the second.
const RESET_ARM_MS = 3000

/** Events other parts of the app send the page: App routes find-in-page and
 *  reload here while the Bangs tab is active. */
export const BANGS_FIND_EVENT = 'vimperium-bangs-find'
export const BANGS_RELOAD_EVENT = 'vimperium-bangs-reload'

type BangsAction = ListMove
  | 'edit' | 'add' | 'toggle' | 'remove' | 'undo' | 'copy' | 'sort' | 'reverse' | 'search'
  | 'engine' | 'bangs' | 'reset' | 'menu' | 'help' | 'escape'

// The page's keys (lib/internal-page-keys.ts). The window's commands it has
// a meaning for — dd deletes, u undoes, y copies, i and / go to the search
// box, e (the address editor's key) edits the bang, never the address — and
// keys of its own, each one taken only while the window's keymap leaves it
// free: by default o opens, so adding is a.
export const BANGS_KEYS: PageKeyTable<BangsAction> = {
  ...LIST_MOVES,
  edit: ['<CR>', cmd('edit-url')],
  add: ['a', 'o'],
  toggle: ['<Space>'],
  remove: [cmd('close-tab'), '<Del>', '<BS>'],
  undo: [cmd('reopen-closed-tab'), 'u'],
  copy: [cmd('copy-url'), 'c'],
  sort: ['s'],
  reverse: ['S', 'O'],
  search: [cmd('find-in-page'), cmd('insert-mode'), cmd('focus-input'), '/'],
  engine: ['E'],
  bangs: ['B'],
  reset: ['R'],
  menu: ['m', cmd('row-menu'), ...CONTEXT_MENU_KEYS],
  help: [cmd('help'), '?'],
  escape: ['<Esc>'],
}

const KEY_HELP: Array<[BangsAction[], string]> = [
  [['down', 'up'], 'Move through the list'],
  [['halfDown', 'halfUp'], 'Half a page down / up'],
  [['pageDown', 'pageUp'], 'A page down / up'],
  [['first', 'last'], 'First / last bang'],
  [['edit'], 'Edit the bang'],
  [['add'], 'Add a bang'],
  [['toggle'], 'Turn the bang on or off'],
  [['remove'], 'Delete the bang'],
  [['undo'], 'Undo the last delete'],
  [['copy'], 'Copy the bang (!w)'],
  [['sort'], 'Next sort'],
  [['reverse'], 'Reverse the order'],
  [['search'], 'Search bangs'],
  [['engine'], 'Next search engine'],
  [['bangs'], 'Turn all bangs on or off'],
  [['reset'], 'Reset to the default bangs (twice)'],
  [['menu'], 'All actions for the selected bang'],
  [['help'], 'Show or hide this help'],
]

const ENGINE_NAMES = Object.keys(SEARCH_ENGINES)

function loadSort(): SortState {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || 'null') as Partial<SortState> | null
    if (v && SORT_KEYS.includes(v.key as SortKey) && (v.dir === 'asc' || v.dir === 'desc')) {
      return { key: v.key as SortKey, dir: v.dir }
    }
  } catch (err) {
    log.warn('bangs page: ignoring a corrupt saved sort', err)
  }
  return { key: 'category', dir: 'asc' }
}

function saveSort(sort: SortState): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort)) }
  catch (err) { log.warn('bangs page: could not save the sort', err) }
}

function categoryRank(category: string): number {
  const at = (BANG_CATEGORIES as readonly string[]).indexOf(category)
  return at === -1 ? BANG_CATEGORIES.length : at
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** Win keyboard focus back for the renderer after a popup (the actions menu)
 *  closes: the OS may hand it to the hidden tab view first. */
function reclaimRendererFocus(): void {
  window.electronAPI?.reclaimWindowRendererFocus?.()
  for (const delay of [60, 180]) {
    setTimeout(() => {
      if (!document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
    }, delay)
  }
}

function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

function newId(): string {
  return `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** The engine's name, or null for a custom template. */
function engineName(template: string): string | null {
  return ENGINE_NAMES.find((n) => SEARCH_ENGINES[n] === template) ?? null
}

interface SearchSettings {
  searchEngine: string
  bangsEnabled: boolean
}

type Row =
  | { kind: 'heading'; key: string; label: string }
  | { kind: 'item'; key: string; bang: Bang }

interface EditorState {
  mode: 'add' | 'edit'
  draft: Bang
}

export function BangsPage() {
  const [bangs, setBangs] = useState<Bang[]>([])
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState<SearchSettings | null>(null)
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>(loadSort)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [undo, setUndo] = useState<Array<{ bang: Bang; index: number }>>([])
  const resetArmedRef = useRef(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const customRef = useRef<HTMLInputElement>(null)
  const api = window.electronAPI

  useEffect(() => { saveSort(sort) }, [sort])

  // Mirror main's table and the two settings.
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.bangsList?.()
        .then((list) => {
          if (!alive) return
          setBangs(list || [])
          setLoaded(true)
        })
        .catch((err) => log.error('bangs page: list failed', err))
      api.loadSettings()
        .then((s) => {
          if (!alive) return
          const raw = s as Partial<SearchSettings>
          setSearch({ searchEngine: raw.searchEngine || SEARCH_ENGINES.Google, bangsEnabled: raw.bangsEnabled !== false })
        })
        .catch((err) => log.error('bangs page: settings load failed', err))
    }
    load()
    const offBangs = api.onBangsUpdated?.((list) => setBangs(list || []))
    const offSettings = api.onSettingsUpdated((s) => {
      const raw = s as Partial<SearchSettings>
      setSearch({ searchEngine: raw.searchEngine || SEARCH_ENGINES.Google, bangsEnabled: raw.bangsEnabled !== false })
    })
    window.addEventListener(BANGS_RELOAD_EVENT, load)
    return () => {
      alive = false
      offBangs?.()
      offSettings()
      window.removeEventListener(BANGS_RELOAD_EVENT, load)
    }
  }, [api])

  const showFlash = useCallback((msg: string) => setFlash(msg), [])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(t)
  }, [flash])

  // ── persistence ──
  const commit = useCallback((next: Bang[], msg?: string) => {
    setBangs(next)
    if (msg) showFlash(msg)
    api.bangsSave?.(next)
      .then((saved) => setBangs(saved))
      .catch((err) => {
        log.error('bangs page: save failed', err)
        showFlash('Could not save the bangs')
      })
  }, [api, showFlash])

  const saveSearchSettings = useCallback(async (patch: Partial<SearchSettings>) => {
    try {
      const fresh = await api.loadSettings()
      await api.saveSettings({ ...fresh, ...patch })
    } catch (err) {
      log.error('bangs page: settings save failed', err)
      showFlash('Could not save the setting')
    }
  }, [api, showFlash])

  // ── list ──
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const qt = normalizeTrigger(q)
    const matched = q
      ? bangs.filter((b) =>
          b.trigger.includes(qt) ||
          b.name.toLowerCase().includes(q) ||
          b.url.toLowerCase().includes(q) ||
          b.category.toLowerCase().includes(q))
      : bangs.slice()
    const sign = sort.dir === 'asc' ? 1 : -1
    matched.sort((a, b) => {
      let cmp = 0
      if (sort.key === 'category') {
        cmp = categoryRank(a.category) - categoryRank(b.category) || a.category.localeCompare(b.category)
        // Within a category: the bang order the seed lists, then by trigger.
        if (cmp === 0) return a.trigger.localeCompare(b.trigger)
      } else if (sort.key === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      else cmp = a.trigger.localeCompare(b.trigger)
      return cmp !== 0 ? cmp * sign : a.trigger.localeCompare(b.trigger)
    })
    return matched
  }, [bangs, query, sort])

  const rows = useMemo(() => {
    const out: Row[] = []
    let last = ''
    for (const b of visible) {
      if (sort.key === 'category' && b.category !== last) {
        out.push({ kind: 'heading', key: `cat-${b.category}`, label: b.category })
        last = b.category
      }
      out.push({ kind: 'item', key: b.id, bang: b })
    }
    return out
  }, [visible, sort.key])

  const selected = visible.find((b) => b.id === selectedId) ?? visible[0] ?? null

  useEffect(() => {
    if (!selected) return
    listRef.current
      ?.querySelector(`[data-bang-id="${CSS.escape(selected.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  // Take the keyboard when the page opens — unless Vim's Ctrl is stepping
  // through tabs, or the user is typing somewhere (the URL bar). Only while
  // the window has the keyboard: opened from a web page (od, ob), the
  // renderer's focused element is a stale one, the URL bar it last had, and
  // leaving it would hand the keys to the URL bar once the window takes
  // them back.
  useEffect(() => {
    if (keepsChromeKeyboard()) return
    if (document.hasFocus() && isEditable(document.activeElement)) return
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const focusList = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const focusSearch = useCallback(() => {
    const input = searchRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    window.addEventListener(BANGS_FIND_EVENT, focusSearch)
    return () => window.removeEventListener(BANGS_FIND_EVENT, focusSearch)
  }, [focusSearch])

  // ── actions ──
  const openEditor = (mode: 'add' | 'edit', bang?: Bang): void => {
    const draft: Bang = bang
      ? { ...bang }
      : { id: newId(), trigger: '', name: '', url: 'https://', category: selected?.category ?? 'Other', enabled: true }
    setEditor({ mode, draft })
  }
  const toggle = (b: Bang): void => {
    commit(bangs.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)), `!${b.trigger} ${b.enabled ? 'off' : 'on'}`)
  }
  const remove = (b: Bang): void => {
    const index = bangs.findIndex((x) => x.id === b.id)
    if (index === -1) return
    const at = visible.findIndex((v) => v.id === b.id)
    const next = visible[at + 1] ?? visible[at - 1]
    setSelectedId(next?.id ?? null)
    setUndo((u) => [...u.slice(-19), { bang: b, index }])
    const undoKey = pageKeys.key('undo')
    commit(bangs.filter((x) => x.id !== b.id), undoKey ? `!${b.trigger} deleted — ${undoKey} to undo` : `!${b.trigger} deleted`)
  }
  const undoRemove = (): void => {
    const last = undo[undo.length - 1]
    if (!last) {
      showFlash('Nothing to undo')
      return
    }
    setUndo((u) => u.slice(0, -1))
    if (bangs.some((x) => x.trigger === last.bang.trigger)) {
      showFlash(`!${last.bang.trigger} is taken now`)
      return
    }
    const next = bangs.slice()
    next.splice(Math.min(last.index, next.length), 0, last.bang)
    setSelectedId(last.bang.id)
    commit(next, `!${last.bang.trigger} restored`)
  }
  const copy = (b: Bang): void => {
    api.clipboardWriteText(`!${b.trigger}`)
    showFlash(`!${b.trigger} copied`)
  }
  const reset = (): void => {
    const now = Date.now()
    if (now - resetArmedRef.current > RESET_ARM_MS) {
      resetArmedRef.current = now
      const resetKey = pageKeys.key('reset')
      showFlash(`Reset to the ${DEFAULT_BANGS.length} default bangs? ${resetKey ? `Press ${resetKey} again` : 'Click Reset again'}`)
      return
    }
    resetArmedRef.current = 0
    setUndo([])
    api.bangsReset?.()
      .then((list) => {
        setBangs(list)
        showFlash('Bangs reset to the defaults')
      })
      .catch((err) => {
        log.error('bangs page: reset failed', err)
        showFlash('Could not reset the bangs')
      })
  }
  const setEngine = (template: string): void => {
    setCustomDraft(null)
    setSearch((s) => (s ? { ...s, searchEngine: template } : s))
    void saveSearchSettings({ searchEngine: template })
  }
  const pickCustom = (): void => {
    setCustomDraft(search && !engineName(search.searchEngine) ? search.searchEngine : '')
    setTimeout(() => customRef.current?.focus(), 0)
  }
  const cycleEngine = (): void => {
    const current = search ? engineName(search.searchEngine) : null
    const at = current ? ENGINE_NAMES.indexOf(current) : -1
    const name = ENGINE_NAMES[(at + 1) % ENGINE_NAMES.length]
    setEngine(SEARCH_ENGINES[name])
    showFlash(`Searching with ${name}`)
  }
  const toggleBangs = (): void => {
    if (!search) return
    const on = !search.bangsEnabled
    setSearch({ ...search, bangsEnabled: on })
    void saveSearchSettings({ bangsEnabled: on })
    showFlash(on ? 'Bangs on' : 'Bangs off — !words go to the search engine')
  }

  const moveBy = (delta: number): void => {
    if (visible.length === 0) return
    const at = selected ? visible.indexOf(selected) : -1
    const next = visible[Math.max(0, Math.min(visible.length - 1, at + delta))]
    if (next) setSelectedId(next.id)
  }
  const moveTo = (index: number): void => {
    const target = index < 0 ? visible[visible.length - 1] : visible[index]
    if (target) setSelectedId(target.id)
  }
  const pageSize = (): number => {
    const list = listRef.current
    const row = list?.querySelector('[data-bang-id]') as HTMLElement | null
    if (!list || !row) return 10
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1)
  }
  const cycleSort = (): void => {
    setSort((s) => ({ key: SORT_KEYS[(SORT_KEYS.indexOf(s.key) + 1) % SORT_KEYS.length], dir: 'asc' }))
  }
  const reverseSort = (): void => {
    setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))
  }
  const pickSort = (key: SortKey): void => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const openMenu = async (b: Bang, at: { x: number; y: number }, keyboard: boolean): Promise<void> => {
    // Each item shows the page's key for it, if it has one.
    const shortcut = (action: BangsAction): string[] | undefined => {
      const key = pageKeys.key(action)
      return key ? [key] : undefined
    }
    const actions: DropdownAction[] = [
      { id: 'edit', label: 'Edit…', iconName: 'Pencil', shortcut: shortcut('edit') },
      { id: 'toggle', label: b.enabled ? 'Turn Off' : 'Turn On', iconName: b.enabled ? 'EyeOff' : 'Zap', shortcut: shortcut('toggle') },
      { id: 'copy', label: `Copy !${b.trigger}`, iconName: 'Link', shortcut: shortcut('copy') },
      // d in the menu, as dd deletes.
      { id: 'delete', label: 'Delete', iconName: 'Trash2', key: 'd', shortcut: shortcut('remove'), destructive: true, divider: 'before' },
      { id: 'add', label: 'Add a Bang…', iconName: 'Plus', shortcut: shortcut('add'), divider: 'before' },
    ]
    const result = await openDropdownAsync({
      kind: 'menu',
      position: at,
      ...readThemeAttrs(),
      header: `!${b.trigger} — ${b.name}`,
      actions,
      ...(keyboard ? { keyboard: true } : {}),
    })
    if (keyboard) {
      reclaimRendererFocus()
      focusList()
    }
    if (!result || result.type !== 'action') return
    switch (result.actionId) {
      case 'edit': openEditor('edit', b); break
      case 'toggle': toggle(b); break
      case 'copy': copy(b); break
      case 'delete': remove(b); break
      case 'add': openEditor('add'); break
    }
  }
  const openMenuForSelected = (): void => {
    if (!selected) return
    const row = listRef.current?.querySelector(`[data-bang-id="${CSS.escape(selected.id)}"]`)
    if (!row) return
    const rect = row.getBoundingClientRect()
    void openMenu(selected, { x: rect.left + 48, y: rect.bottom }, true)
  }

  // ── keyboard ──
  // BANGS_KEYS through lib/internal-page-keys.ts, while the page has the
  // keyboard (INSERT): its own keys, and the window's commands it has a
  // meaning for on the window's keymap.
  /** Back into the bang form, from keys outside it (Ctrl+[ left it). */
  const focusEditor = (): void => {
    rootRef.current?.querySelector<HTMLInputElement>('[role="dialog"] input')?.focus()
  }
  const runKey: PageKeyRunner<BangsAction> = (action) => {
    if (action !== 'reset') resetArmedRef.current = 0
    if (editor) {
      // The form is up without the keys: Esc closes it, Enter or i goes
      // back into it, and the rest wait for it — dd mustn't close the tab
      // under it.
      if (action === 'escape') {
        setEditor(null)
        focusList()
      } else if (action === 'edit' || action === 'search') {
        focusEditor()
      }
      return true
    }
    switch (action) {
      case 'escape':
        if (!helpOpen) return false
        setHelpOpen(false)
        return true
      case 'help': setHelpOpen((v) => !v); return true
      case 'down': moveBy(1); return true
      case 'up': moveBy(-1); return true
      case 'halfDown': moveBy(Math.max(1, Math.floor(pageSize() / 2))); return true
      case 'halfUp': moveBy(-Math.max(1, Math.floor(pageSize() / 2))); return true
      case 'pageDown': moveBy(pageSize()); return true
      case 'pageUp': moveBy(-pageSize()); return true
      case 'first': moveTo(0); return true
      case 'last': moveTo(-1); return true
      case 'search': focusSearch(); return true
      case 'sort': cycleSort(); return true
      case 'reverse': reverseSort(); return true
      case 'add': openEditor('add'); return true
      case 'undo': undoRemove(); return true
      case 'engine': cycleEngine(); return true
      case 'bangs': toggleBangs(); return true
      case 'reset': reset(); return true
      case 'menu': openMenuForSelected(); return true
    }
    if (!selected) {
      // dd with nothing to delete does nothing — it never closes the tab
      // here. The rest do nothing either: the window's own keys are
      // COMMAND's.
      return action === 'remove'
    }
    switch (action) {
      case 'edit': openEditor('edit', selected); return true
      case 'toggle': toggle(selected); return true
      case 'copy': copy(selected); return true
      case 'remove': remove(selected); return true
    }
    return false
  }
  const pageKeys = useInternalPageKeys({
    table: BANGS_KEYS,
    run: runKey,
    // The keys are the page's while the focus is in it (INSERT) and not in
    // a field; on nothing at all it's COMMAND, the browser's keys. The bang
    // form keeps its own; with it up and the focus outside it, runKey's
    // editor branch has them (i or Enter back in, Esc closes it). A focused
    // control (Tab onto a header button) keeps its own Enter / Space.
    ownsKeyboard: (e) => {
      const root = rootRef.current
      const target = e.target
      if (!root || isEditable(target)) return false
      if (!(target instanceof Node && root.contains(target))) return false
      if (editor && target instanceof Element && target.closest('[role="dialog"]')) return false
      return !((e.key === 'Enter' || e.key === ' ') && target instanceof HTMLElement && target.closest('button, a, [role="radio"]'))
    },
  })
  const keyOf = pageKeys.key
  /** An action's key for the hint bar; none when the keymap took them all. */
  const hintKeys = (action: BangsAction): string[] => {
    const key = keyOf(action)
    return key ? [key] : []
  }

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      if (visible[0]) setSelectedId(visible[0].id)
      focusList()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery('')
      else focusList()
    }
  }

  const customProblem = customDraft !== null ? searchEngineProblem(customDraft) : null
  const commitCustom = (): void => {
    if (customDraft === null) return
    if (customProblem) {
      showFlash(customProblem)
      return
    }
    setEngine(customDraft.trim())
    showFlash('Custom search engine saved')
    focusList()
  }
  const onCustomKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitCustom()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setCustomDraft(null)
      focusList()
    }
  }

  const offCount = bangs.filter((b) => !b.enabled).length
  const summary = bangs.length === 0
    ? ''
    : `${bangs.length} ${bangs.length === 1 ? 'bang' : 'bangs'}${offCount > 0 ? ` · ${offCount} off` : ''}`
  const currentEngine = search ? engineName(search.searchEngine) : null
  const customActive = customDraft !== null || (!!search && !currentEngine)
  const bangsOn = search?.bangsEnabled !== false
  const helpNote = pageKeys.keymap ? windowKeysNote(pageKeys.keymap) : null

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      // The focus in it is INSERT, as in a web page: its own keys run
      // (lib/internal-page-keys.ts); Esc lets go of it for COMMAND. The bang
      // form inside is data-vim-page too: a form keeps its own keys.
      data-vim-page=""
      // i lands on the page: with the bang form up, it goes back into it.
      onFocus={(e) => { if (editor && e.target === e.currentTarget) focusEditor() }}
      // The keys leaving the page (Esc for COMMAND, a click on the chrome)
      // take its help along: nothing but its own keys would close it.
      onBlur={(e) => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setHelpOpen(false) }}
      className="absolute inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
      role="region"
      aria-label="Bangs"
    >
      <div className="shrink-0 border-b border-border">
        {/* Title + global actions. */}
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 pt-5 pb-3">
          <Zap size={18} className="text-primary shrink-0" />
          <h1 className="text-lg font-semibold tracking-tight">Bangs</h1>
          {summary && <span className="text-xs text-muted-foreground tabular-nums">{summary}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => openEditor('add')}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title={titleWithKey('Add a bang', keyOf('add'))}
            >
              <Plus size={14} />
              Add
              {keyOf('add') && <KeyCap>{keyOf('add')}</KeyCap>}
            </button>
            <button
              onClick={reset}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title={`Put the default bangs back, dropping your changes (${keyOf('reset') ? `${keyOf('reset')} twice, or click twice` : 'click twice'})`}
            >
              <RotateCcw size={14} />
              Reset
              {keyOf('reset') && <KeyCap>{keyOf('reset')}</KeyCap>}
            </button>
          </div>
        </div>

        {/* Where plain queries go, and whether !words fire. */}
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Search engine {keyOf('engine') && <KeyCap>{keyOf('engine')}</KeyCap>}
          </span>
          <div className="flex h-9 items-center rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="Search engine">
            {ENGINE_NAMES.map((name) => {
              const active = !customActive && currentEngine === name
              return (
                <button
                  key={name}
                  role="radio"
                  aria-checked={active}
                  onClick={() => setEngine(SEARCH_ENGINES[name])}
                  className={`flex h-8 items-center rounded px-2.5 text-xs font-medium transition-colors ${
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title={SEARCH_ENGINES[name]}
                >
                  {name}
                </button>
              )
            })}
            <button
              role="radio"
              aria-checked={customActive}
              onClick={pickCustom}
              className={`flex h-8 items-center rounded px-2.5 text-xs font-medium transition-colors ${
                customActive ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Your own search address, %s standing for the query"
            >
              Custom
            </button>
          </div>
          <button
            role="switch"
            aria-checked={bangsOn}
            onClick={toggleBangs}
            className={`ml-auto flex h-9 items-center gap-2 rounded-md px-2.5 text-xs font-medium transition-colors ${
              bangsOn ? 'bg-primary/15 text-primary hover:bg-primary/20' : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
            title={titleWithKey('Bangs on: !w vim goes straight to Wikipedia. Off: it goes to the search engine as typed', keyOf('bangs'))}
          >
            {bangsOn ? <Power size={14} /> : <PowerOff size={14} />}
            {bangsOn ? 'Bangs on' : 'Bangs off'}
            {keyOf('bangs') && <KeyCap>{keyOf('bangs')}</KeyCap>}
          </button>
        </div>
        {customActive && (
          <div className="mx-auto max-w-4xl px-6 pb-3">
            <input
              ref={customRef}
              type="text"
              value={customDraft ?? search?.searchEngine ?? ''}
              onChange={(e) => setCustomDraft(e.target.value)}
              onFocus={() => { if (customDraft === null) setCustomDraft(search?.searchEngine ?? '') }}
              onKeyDown={onCustomKeyDown}
              onBlur={() => { if (customDraft !== null && !customProblem && customDraft.trim() !== search?.searchEngine) commitCustom() }}
              placeholder="https://example.com/search?q=%s"
              spellCheck={false}
              className="h-9 w-full field rounded-xl px-3 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <p className={`mt-1 text-[11px] ${customDraft !== null && customProblem && customDraft.trim() ? 'text-destructive' : 'text-muted-foreground'}`}>
              {customDraft !== null && customProblem && customDraft.trim()
                ? customProblem
                : 'Put %s where the query goes. Enter saves, Esc leaves it as it was.'}
            </p>
          </div>
        )}

        {/* Search and sort. */}
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 pb-4">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search bangs"
              spellCheck={false}
              className="h-9 w-full field rounded-xl pl-9 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            {query ? (
              <button
                onClick={() => { setQuery(''); focusSearch() }}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear search (Esc)"
                tabIndex={-1}
              >
                <X size={13} />
              </button>
            ) : (
              keyOf('search') && (
                <span className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2">
                  <KeyCap onField>{keyOf('search')}</KeyCap>
                </span>
              )
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Sort by {keyOf('sort') && <KeyCap>{keyOf('sort')}</KeyCap>}
            </span>
            <div className="flex h-9 items-center rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="Sort bangs">
              {SORT_KEYS.map((key) => {
                const active = sort.key === key
                return (
                  <button
                    key={key}
                    role="radio"
                    aria-checked={active}
                    onClick={() => pickSort(key)}
                    className={`flex h-8 items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors ${
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={active
                      ? titleWithKey('Reverse the order', keyOf('reverse'))
                      : `Sort by ${SORT_LABELS[key].toLowerCase()}${keyOf('sort') ? ` (${keyOf('sort')} cycles)` : ''}`}
                  >
                    {SORT_LABELS[key]}
                    {active && (sort.dir === 'desc'
                      ? <ArrowDownWideNarrow size={13} />
                      : <ArrowUpNarrowWide size={13} />)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} className={`min-h-0 flex-1 overflow-y-auto ${bangsOn ? '' : 'opacity-60'}`}>
        <div
          className="mx-auto max-w-4xl px-4 py-3"
          role="listbox"
          aria-label="Bangs"
          aria-activedescendant={selected ? `bang-${selected.id}` : undefined}
        >
          {loaded && bangs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
              <Zap size={30} className="mb-3 opacity-50" />
              <p className="text-sm font-medium text-foreground">No bangs</p>
              <p className="mt-1 text-xs">
                {keyOf('add') ? <>Add one with <KeyCap>{keyOf('add')}</KeyCap></> : 'Add one'}
                {keyOf('reset')
                  ? <>, or bring the defaults back with <KeyCap>{keyOf('reset')}</KeyCap> twice.</>
                  : ', or bring the defaults back with Reset.'}
              </p>
            </div>
          )}
          {bangs.length > 0 && visible.length === 0 && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No bangs match “{query.trim()}”.
            </p>
          )}
          {rows.map((row) =>
            row.kind === 'heading' ? (
              <div
                key={row.key}
                className="px-3 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:pt-1"
              >
                {row.label}
              </div>
            ) : (
              <BangRow
                key={row.key}
                bang={row.bang}
                selected={row.bang.id === selected?.id}
                showCategory={sort.key !== 'category'}
                keyOf={keyOf}
                onSelect={() => { setSelectedId(row.bang.id); focusList() }}
                onEdit={() => openEditor('edit', row.bang)}
                onToggle={() => toggle(row.bang)}
                onCopy={() => copy(row.bang)}
                onRemove={() => remove(row.bang)}
                onContextMenu={(at) => { setSelectedId(row.bang.id); void openMenu(row.bang, at, false) }}
              />
            ),
          )}
        </div>
      </div>

      <HintBar>
        {flash ? (
          <span className="text-foreground">{flash}</span>
        ) : (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
            <Hint label="Navigate" keys={[keyOf('down'), keyOf('up')].filter((k): k is string => !!k)} />
            <Hint label="Edit" keys={hintKeys('edit')} />
            <Hint label="Add" keys={hintKeys('add')} />
            <Hint label="On/off" keys={hintKeys('toggle')} />
            <Hint label="Delete" keys={hintKeys('remove')} />
            <Hint label="Undo" keys={hintKeys('undo')} />
            <Hint label="Search" keys={hintKeys('search')} />
            <Hint label="Engine" keys={hintKeys('engine')} />
            <Hint label="Actions" keys={hintKeys('menu')} />
          </div>
        )}
        <button
          onClick={() => setHelpOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
          title={titleWithKey('Keyboard shortcuts', keyOf('help'))}
          tabIndex={-1}
        >
          <Keyboard size={13} />
          {keyOf('help') && <kbd>{keyOf('help')}</kbd>}
        </button>
      </HintBar>

      {helpOpen && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 backdrop-blur-[1px]"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-[440px] max-w-[90%] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
              <button
                onClick={() => setHelpOpen(false)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close keyboard shortcuts"
              >
                <X size={13} />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {KEY_HELP.map(([actions, what]) => {
                const keys = helpKeys(pageKeys.caps, actions)
                // A key the keymap took for something else: the menu (or ;)
                // still reaches the action.
                if (!keys) return null
                return (
                  <div key={what} className="contents">
                    <dt className="font-mono text-foreground">{keys}</dt>
                    <dd className="text-muted-foreground">{what}</dd>
                  </div>
                )
              })}
            </dl>
            {helpNote && <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{helpNote}</p>}
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              In the address bar a <span className="font-mono">!trigger</span> anywhere in what you type fires its bang:
              <span className="font-mono"> !w vim</span> and <span className="font-mono">vim !w</span> both open Wikipedia's search for “vim”;
              <span className="font-mono"> !w</span> alone opens Wikipedia.
            </p>
          </div>
        </div>
      )}

      {editor && (
        <BangEditor
          state={editor}
          others={bangs}
          categories={[...new Set([...BANG_CATEGORIES, ...bangs.map((b) => b.category)])]}
          onCancel={() => { setEditor(null); focusList() }}
          onSave={(draft) => {
            const clean: Bang = {
              ...draft,
              trigger: normalizeTrigger(draft.trigger),
              name: draft.name.trim(),
              url: draft.url.trim(),
              category: draft.category.trim() || 'Other',
            }
            const next = editor.mode === 'add'
              ? [...bangs, clean]
              : bangs.map((b) => (b.id === clean.id ? clean : b))
            setSelectedId(clean.id)
            setEditor(null)
            commit(next, editor.mode === 'add' ? `!${clean.trigger} added` : `!${clean.trigger} saved`)
            focusList()
          }}
        />
      )}
    </div>
  )
}

function BangEditor({
  state, others, categories, onCancel, onSave,
}: {
  state: EditorState
  others: Bang[]
  categories: string[]
  onCancel: () => void
  onSave: (draft: Bang) => void
}) {
  const [draft, setDraft] = useState<Bang>(state.draft)
  const [tried, setTried] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  const problem = bangProblem(draft, others)
  const trigger = normalizeTrigger(draft.trigger) || 'trigger'
  const example = draft.url.includes('%s') || /\{\{\{s\}\}\}|\{\{query\}\}/.test(draft.url) ? 'example' : ''

  useEffect(() => {
    const input = firstRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const submit = (): void => {
    setTried(true)
    if (!problem) onSave(draft)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      e.stopPropagation()
      submit()
    }
  }
  const field = 'h-9 w-full field rounded-xl px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground'
  const label = 'mb-1 block text-xs font-medium text-muted-foreground'

  return (
    <div
      // To Vim mode a form keeps its own keys (INSERT): Tab moves on
      // through it, Enter saves, Esc cancels, Space flips the switch.
      data-vim-page=""
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 backdrop-blur-[1px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="w-[520px] max-w-[92%] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl"
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label={state.mode === 'add' ? 'Add a bang' : 'Edit bang'}
      >
        <div className="mb-4 flex items-center gap-2">
          <Zap size={15} className="text-primary" />
          <h2 className="text-sm font-semibold">{state.mode === 'add' ? 'Add a bang' : `Edit !${state.draft.trigger}`}</h2>
          <button
            onClick={onCancel}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Cancel"
            tabIndex={-1}
          >
            <X size={13} />
          </button>
        </div>
        <div className="mb-4 flex items-start justify-between gap-4 rounded-md bg-secondary/60 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Turned on</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {draft.enabled
                ? `!${trigger} in the address bar opens this site's search.`
                : `Kept in the list, but the address bar ignores !${trigger} — it goes to the search engine as typed.`}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label="Turned on"
            onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
            className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
              draft.enabled ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                draft.enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        <div className="grid grid-cols-[140px_1fr] gap-3">
          <label className="block">
            <span className={label}>Trigger</span>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted-foreground">!</span>
              <input
                ref={firstRef}
                value={draft.trigger}
                onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
                placeholder="w"
                spellCheck={false}
                className={`${field} pl-6 font-mono`}
              />
            </div>
          </label>
          <label className="block">
            <span className={label}>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Wikipedia"
              className={field}
            />
          </label>
        </div>
        <label className="mt-3 block">
          <span className={label}>Address — %s is the query</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://en.wikipedia.org/wiki/Special:Search?search=%s"
            spellCheck={false}
            className={`${field} font-mono`}
          />
        </label>
        <label className="mt-3 block">
          <span className={label}>Category</span>
          <input
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            list="vimperium-bang-categories"
            placeholder="Other"
            className={field}
          />
          <datalist id="vimperium-bang-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <div className="mt-4 min-h-[2.5rem] rounded-md bg-secondary/60 px-3 py-2 text-[11px]">
          {tried && problem ? (
            <span className="text-destructive">{problem}</span>
          ) : (
            <span className="block truncate text-muted-foreground">
              <span className="font-mono text-foreground">!{trigger}{example ? ` ${example}` : ''}</span>
              {' → '}
              <span className="font-mono">{/^https?:\/\//i.test(draft.url) ? expandBang(draft, example) : '…'}</span>
            </span>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Cancel <KeyCap>Esc</KeyCap>
          </button>
          <button
            onClick={submit}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            {state.mode === 'add' ? 'Add' : 'Save'} <KeyCap onPrimary>Enter</KeyCap>
          </button>
        </div>
      </div>
    </div>
  )
}

function BangRow({
  bang, selected, showCategory, keyOf, onSelect, onEdit, onToggle, onCopy, onRemove, onContextMenu,
}: {
  bang: Bang
  selected: boolean
  showCategory: boolean
  /** The page's key for an action, for the buttons' tooltips. */
  keyOf: (action: BangsAction) => string | undefined
  onSelect: () => void
  onEdit: () => void
  onToggle: () => void
  onCopy: () => void
  onRemove: () => void
  onContextMenu: (at: { x: number; y: number }) => void
}) {
  const iconButton = 'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'
  return (
    <div
      id={`bang-${bang.id}`}
      data-bang-id={bang.id}
      role="option"
      aria-selected={selected}
      onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); onSelect() } }}
      onDoubleClick={onEdit}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu({ x: e.clientX, y: e.clientY }) }}
      className={`group relative flex items-center gap-3 rounded-lg py-2 pl-4 pr-2 transition-colors ${
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'
      }`}
    >
      {selected && <span className="pointer-events-none absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-primary" />}
      <span
        className={`w-24 shrink-0 truncate rounded-md px-2 py-1 font-mono text-[13px] font-semibold ${
          bang.enabled ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground line-through'
        }`}
        title={`!${bang.trigger}`}
      >
        !{bang.trigger}
      </span>
      <div className={`min-w-0 flex-1 ${bang.enabled ? '' : 'opacity-60'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{bang.name}</span>
          {!bang.enabled && (
            <span className="shrink-0 rounded bg-secondary px-1.5 py-px text-[10px] font-semibold text-muted-foreground">Off</span>
          )}
          {showCategory && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{bang.category}</span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={bang.url}>
          {bang.url}
        </div>
      </div>
      <div className={`flex w-[124px] shrink-0 items-center justify-end gap-0.5 ${
        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}>
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onToggle() }} className={iconButton} title={titleWithKey(bang.enabled ? 'Turn off' : 'Turn on', keyOf('toggle'))}>
          {bang.enabled ? <Power size={14} /> : <PowerOff size={14} />}
        </button>
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onCopy() }} className={iconButton} title={titleWithKey(`Copy !${bang.trigger}`, keyOf('copy'))}>
          <Copy size={14} />
        </button>
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onEdit() }} className={iconButton} title={titleWithKey('Edit', keyOf('edit'))}>
          <Pencil size={14} />
        </button>
        <button
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className={`${iconButton} hover:text-destructive`}
          title={titleWithKey('Delete', keyOf('remove'))}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}
