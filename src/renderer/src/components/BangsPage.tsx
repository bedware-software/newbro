// Bangs page (newbro://bangs) — the bang table behind `!w vim` in the address
// bar (src/shared/bangs.ts), and the search engine plain queries go to. An
// internal page like Downloads (lib/internal-pages.ts): WebviewPanel draws it
// over the page area, and it takes the same keys — see KEY_HELP (`?`).
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
const SORT_STORAGE_KEY = 'newbro-bangs-sort'

// How long the second `g` of `gg` may trail the first (same as Vim mode's).
const GG_TIMEOUT_MS = 1000
// How long the first R of "R R" (reset to defaults) waits for the second.
const RESET_ARM_MS = 3000

/** Events other parts of the app send the page: App routes find-in-page and
 *  reload here while the Bangs tab is active. */
export const BANGS_FIND_EVENT = 'newbro-bangs-find'
export const BANGS_RELOAD_EVENT = 'newbro-bangs-reload'

const KEY_HELP: Array<[string, string]> = [
  ['j / k, ↓ / ↑', 'Move through the list'],
  ['gg / G, Home / End', 'First / last bang'],
  ['Enter, e', 'Edit the bang'],
  ['a, o', 'Add a bang'],
  ['Space', 'Turn the bang on or off'],
  ['x, Delete', 'Delete the bang'],
  ['u', 'Undo the last delete'],
  ['y, c', 'Copy the bang (!w)'],
  ['s / S', 'Next sort / reverse order'],
  ['/', 'Search bangs'],
  ['E', 'Next search engine'],
  ['B', 'Turn all bangs on or off'],
  ['R R', 'Reset to the default bangs'],
  ['m', 'All actions for the selected bang'],
  ['?', 'Show or hide this help'],
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
  const pendingGRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  // through tabs, or the user is typing somewhere (the URL bar).
  useEffect(() => {
    if (keepsChromeKeyboard()) return
    if (isEditable(document.activeElement)) return
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
    commit(bangs.filter((x) => x.id !== b.id), `!${b.trigger} deleted — u to undo`)
  }
  const undoRemove = (): void => {
    const last = undo[undo.length - 1]
    if (!last) return
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
      showFlash(`Reset to the ${DEFAULT_BANGS.length} default bangs? Press R again`)
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
    const actions: DropdownAction[] = [
      { id: 'edit', label: 'Edit…', iconName: 'Pencil', shortcut: ['Enter'] },
      { id: 'toggle', label: b.enabled ? 'Turn Off' : 'Turn On', iconName: b.enabled ? 'EyeOff' : 'Zap', shortcut: ['Space'] },
      { id: 'copy', label: `Copy !${b.trigger}`, iconName: 'Link', shortcut: ['y'] },
      { id: 'delete', label: 'Delete', iconName: 'Trash2', shortcut: ['x'], destructive: true, divider: 'before' },
      { id: 'add', label: 'Add a Bang…', iconName: 'Plus', shortcut: ['a'], divider: 'before' },
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
  // Registered once; the ref always points at this render's handler.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  onKeyRef.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return
    const root = rootRef.current
    if (!root || editor) return
    const target = e.target
    const onPage = target === document.body || target === document.documentElement ||
      (target instanceof Node && root.contains(target))
    if (!onPage || isEditable(target)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.key === 'Enter' || e.key === ' ') && target instanceof HTMLElement && target.closest('button, a, [role="radio"]')) return

    if (e.key === 'Escape' && helpOpen) {
      e.preventDefault()
      e.stopPropagation()
      setHelpOpen(false)
      return
    }
    if (e.key !== 'R') resetArmedRef.current = 0

    let handled = true
    if (e.key === 'g' && !e.shiftKey) {
      if (pendingGRef.current) {
        clearTimeout(pendingGRef.current)
        pendingGRef.current = null
        moveTo(0)
      } else {
        pendingGRef.current = setTimeout(() => { pendingGRef.current = null }, GG_TIMEOUT_MS)
      }
      e.preventDefault()
      return
    }
    if (pendingGRef.current) {
      clearTimeout(pendingGRef.current)
      pendingGRef.current = null
    }
    switch (e.key) {
      case 'j':
      case 'ArrowDown': moveBy(1); break
      case 'k':
      case 'ArrowUp': moveBy(-1); break
      case 'Home': moveTo(0); break
      case 'G':
      case 'End': moveTo(-1); break
      case 'PageDown': moveBy(pageSize()); break
      case 'PageUp': moveBy(-pageSize()); break
      case '/': focusSearch(); break
      case 's': cycleSort(); break
      case 'S': reverseSort(); break
      case '?': setHelpOpen((v) => !v); break
      case 'a':
      case 'o': openEditor('add'); break
      case 'u': undoRemove(); break
      case 'E': cycleEngine(); break
      case 'B': toggleBangs(); break
      case 'R': reset(); break
      case 'ContextMenu': openMenuForSelected(); break
      case 'F10':
        if (e.shiftKey) openMenuForSelected()
        else handled = false
        break
      default:
        handled = false
    }
    if (!handled && selected) {
      handled = true
      switch (e.key) {
        case 'Enter':
        case 'e':
        case 'i': openEditor('edit', selected); break
        case ' ': toggle(selected); break
        case 'c':
        case 'y': copy(selected); break
        case 'x':
        case 'Delete':
        case 'Backspace': remove(selected); break
        case 'm': openMenuForSelected(); break
        default: handled = false
      }
    }
    if (!handled) return
    e.preventDefault()
    e.stopPropagation()
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => onKeyRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (pendingGRef.current) clearTimeout(pendingGRef.current)
    }
  }, [])

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

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      // To Vim mode this is a page: keys here are INSERT, its own j/k & co.
      data-vim-page=""
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
              title="Add a bang (a)"
            >
              <Plus size={14} />
              Add
              <KeyCap>a</KeyCap>
            </button>
            <button
              onClick={reset}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Put the default bangs back, dropping your changes (R twice, or click twice)"
            >
              <RotateCcw size={14} />
              Reset
              <KeyCap>R</KeyCap>
            </button>
          </div>
        </div>

        {/* Where plain queries go, and whether !words fire. */}
        <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">Search engine <KeyCap>E</KeyCap></span>
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
            title="Bangs on: !w vim goes straight to Wikipedia. Off: it goes to the search engine as typed (B)"
          >
            {bangsOn ? <Power size={14} /> : <PowerOff size={14} />}
            {bangsOn ? 'Bangs on' : 'Bangs off'}
            <KeyCap>B</KeyCap>
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
              <span className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2">
                <KeyCap onField>/</KeyCap>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">Sort by <KeyCap>s</KeyCap></span>
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
                    title={active ? 'Reverse the order (Shift+S)' : `Sort by ${SORT_LABELS[key].toLowerCase()} (s cycles)`}
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
              <p className="mt-1 text-xs">Add one with <KeyCap>a</KeyCap>, or bring the defaults back with <KeyCap>R</KeyCap> twice.</p>
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
            <Hint label="Navigate" keys={['j', 'k']} />
            <Hint label="Edit" keys={['Enter']} />
            <Hint label="Add" keys={['a']} />
            <Hint label="On/off" keys={['Space']} />
            <Hint label="Delete" keys={['x']} />
            <Hint label="Undo" keys={['u']} />
            <Hint label="Search" keys={['/']} />
            <Hint label="Engine" keys={['E']} />
            <Hint label="Actions" keys={['m']} />
          </div>
        )}
        <button
          onClick={() => setHelpOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
          title="Keyboard shortcuts (?)"
          tabIndex={-1}
        >
          <Keyboard size={13} />
          <kbd>?</kbd>
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
              {KEY_HELP.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt className="font-mono text-foreground">{keys}</dt>
                  <dd className="text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
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
        <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-3">
          <label className="block">
            <span className={label}>Category</span>
            <input
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
              list="newbro-bang-categories"
              placeholder="Other"
              className={field}
            />
            <datalist id="newbro-bang-categories">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
          <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            On
          </label>
        </div>
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
            {state.mode === 'add' ? 'Add' : 'Save'} <KeyCap>Enter</KeyCap>
          </button>
        </div>
      </div>
    </div>
  )
}

function BangRow({
  bang, selected, showCategory, onSelect, onEdit, onToggle, onCopy, onRemove, onContextMenu,
}: {
  bang: Bang
  selected: boolean
  showCategory: boolean
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
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onToggle() }} className={iconButton} title={bang.enabled ? 'Turn off (Space)' : 'Turn on (Space)'}>
          {bang.enabled ? <Power size={14} /> : <PowerOff size={14} />}
        </button>
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onCopy() }} className={iconButton} title={`Copy !${bang.trigger} (Y)`}>
          <Copy size={14} />
        </button>
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onEdit() }} className={iconButton} title="Edit (Enter)">
          <Pencil size={14} />
        </button>
        <button
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className={`${iconButton} hover:text-destructive`}
          title="Delete (X)"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}
