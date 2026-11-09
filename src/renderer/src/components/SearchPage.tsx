// Search Everything as a page (vimperium://search): ot ow og op open it on
// one kind of thing — tabs, tab groups, workspaces, profiles — and picking
// a result goes there, the page's tab closing behind it.
//
// It has no box of its own: the address bar is its filter
// (lib/address-filter.ts), typing at once when it opens. In the bar ↑/↓ and
// PageUp/PageDown move through the results, Enter opens the selected one,
// Tab / Shift+Tab step through the four kinds, Alt+S flips the scope (this
// workspace / every one) for tabs and groups; Esc leaves the bar for
// COMMAND, the query kept.
//
// In COMMAND (lib/vim-mode.ts usePageKeys) the scroll keys move the
// selection, Enter opens it, i / gi type in the bar again, m opens the
// selected row's menu, and Esc closes the page — back to the tab you were
// on. Every result wears a label that picks it (lib/hint-labels.ts), the one
// the Sidebar gives the same tab or group. ot ow og op, typed here, ask for
// the page again on another kind (lib/page-nav.ts).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, User, Layout, Layers, Globe } from 'lucide-react'
import { useAppStore, saveStateNow } from '../store/app-store'
import type { SearchableItem } from '../store/types'
import { log } from '../lib/log'
import { fuzzyFilter } from '../lib/fuzzy'
import { focusAddressFilter, useAddressFilter, type AddressFilterKeyEvent } from '../lib/address-filter'
import { closePage, closePageTab, useSearchPageRequest, type SearchFilter } from '../lib/page-nav'
import { internalPageOf } from '../lib/internal-pages'
import { useHintLabels, useHintTargets } from '../lib/hint-labels'
import { usePageKeys } from '../lib/vim-mode'
import { keyTokenFromEvent } from '../lib/vim-keymap'
import type { VimKeymap } from '../lib/vim-keymap'
import type { VimMode } from '../lib/vim-mode'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'
import { GroupPill } from './GroupPill'
import { RowHint } from './KeyHints'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'
import { InputDialog } from './InputDialog'
import { ConfirmDialog } from './ConfirmDialog'

export interface SearchPageProps {
  /** The page's own tab: picking a result closes it. */
  tabId: string
  windowWorkspaceId: string | null
  /** COMMAND's keys (the window's), for the hints; null for the beat at launch. */
  vimKeymap: VimKeymap | null
  vimMode: VimMode | null
  vimPending: string
  /** Its rows may wear COMMAND's labels: no popup has its own up. */
  hintsOn: boolean
}

const FILTER_TYPES = ['profile', 'workspace', 'tabGroup', 'tab'] as const
type FilterType = SearchFilter

const TYPE_ICONS: Record<FilterType, typeof User> = {
  profile: User,
  workspace: Layout,
  tabGroup: Layers,
  tab: Globe,
}

const TYPE_LABELS: Record<FilterType, string> = {
  profile: 'Profiles',
  workspace: 'Workspaces',
  tabGroup: 'Tab Groups',
  tab: 'Tabs',
}

/** The bar's placeholder: what's searched, and where. */
function placeholderFor(filter: FilterType, scoped: boolean | null): string {
  const what = filter === 'tabGroup' ? 'tab groups' : TYPE_LABELS[filter].toLowerCase()
  if (scoped === null) return `Search ${what}…`
  return `Search ${what} ${scoped ? 'in this workspace' : 'in every workspace'}…`
}

/** Where tab groups / tabs are searched: every workspace or only the one this window shows. */
type SearchScope = 'all' | 'current'

const FILTER_STORAGE_KEY = 'vimperium-search-filter'
const SCOPE_STORAGE_KEY = 'vimperium-search-scope'

/** The filter picked last; tabs at first (a stale "all" too). */
function loadFilter(): FilterType {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if ((FILTER_TYPES as readonly string[]).includes(raw ?? '')) return raw as FilterType
  } catch { /* no storage: the default */ }
  return 'tab'
}

function saveFilter(filter: FilterType): void {
  try { localStorage.setItem(FILTER_STORAGE_KEY, filter) } catch { /* not remembered */ }
}

function loadScope(): SearchScope {
  // The window's own workspace by default: searching tabs/groups usually
  // means "find something in what I'm looking at".
  try {
    return localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'current'
  } catch {
    return 'current'
  }
}

function saveScope(scope: SearchScope): void {
  try { localStorage.setItem(SCOPE_STORAGE_KEY, scope) } catch { /* not remembered */ }
}

// The page is mounted while its tab is the active one: these outlive a
// remount (another tab shown and this one again) — the request already
// answered isn't answered twice, and the page shows the kind it showed. It
// starts at the request there is when the app starts (none), so a search tab
// restored at launch isn't taken for one.
let handledRequest = useSearchPageRequest.getState().v
let shownFilter: FilterType | null = null

const isMac = navigator.platform.includes('Mac')
const SCOPE_KEY_CAP = isMac ? '⌥S' : 'Alt+S'
const HALF_PAGE_ROWS = 10

/** Its rows' ids among the window's hint targets: the Sidebar's for a tab
 *  or a group, so one thing wears one label wherever it's listed. */
function hintId(item: SearchableItem): string {
  switch (item.type) {
    case 'tab': return `tab:${item.id}`
    case 'tabGroup': return `group:${item.id}`
    case 'workspace': return `workspace:${item.id}`
    case 'profile': return `profile:${item.id}`
  }
}

/** The theme for the row menu's popup (its own window). */
function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

/** A row menu's follow-up that needs a dialog of its own. */
type RowDialog =
  | { kind: 'rename-workspace'; id: string; name: string }
  | { kind: 'rename-group'; id: string; name: string }
  | { kind: 'delete-workspace'; id: string; name: string; tabCount: number }

/** What a row's menu (m in COMMAND, or a right-click) offers, with a key
 *  each — the Sidebar's letters where it has the same action. */
function rowMenuActions(item: SearchableItem): DropdownAction[] {
  switch (item.type) {
    case 'tab':
      return [
        { id: 'close-tab', label: 'Close Tab', iconName: 'X', key: 'x' },
        { id: 'duplicate-tab', label: 'Duplicate Tab', iconName: 'CopyPlus', key: 'd' },
        { id: 'move-tab', label: 'Move Tab…', iconName: 'FolderInput', key: 'm', divider: 'before' },
      ]
    case 'tabGroup':
      return [
        { id: 'rename-group', label: 'Rename Group…', iconName: 'Pencil', key: 'r' },
        { id: 'close-group', label: 'Close Group', iconName: 'X', key: 'x', destructive: true, divider: 'before' },
      ]
    case 'workspace': {
      // A profile keeps at least one workspace (the profile menu's rule).
      const profile = useAppStore.getState().profiles.find((p) => p.id === item.profileId)
      const last = (profile?.workspaces.length ?? 0) <= 1
      return [
        { id: 'rename-workspace', label: 'Rename Workspace…', iconName: 'Pencil', key: 'r' },
        {
          id: 'delete-workspace',
          label: 'Delete Workspace…',
          iconName: 'Trash2',
          key: 'x',
          destructive: true,
          divider: 'before',
          disabled: last,
          disabledTitle: last ? 'A profile keeps at least one workspace' : undefined,
        },
      ]
    }
    default:
      return []
  }
}

function SearchBreadcrumb({ item }: { item: SearchableItem }) {
  const visibleUrl = item.url && item.url !== 'about:blank' ? item.url : undefined
  const fullLabel = `${item.path}${visibleUrl ? ` · ${visibleUrl}` : ''}`
  // A group's own row already wears the colour on its label, so the group
  // crumb is only a pill where the label is something else (a tab).
  const pillGroupCrumb = !!item.groupColor && item.type !== 'tabGroup'

  return (
    <div className="truncate text-[10px] text-muted-foreground" title={fullLabel}>
      {item.pathSegments.map((segment, index) => (
        <span key={`${segment.type}-${index}`}>
          {index > 0 && <span aria-hidden="true"> / </span>}
          {segment.type === 'tabGroup' && pillGroupCrumb
            ? <GroupPill name={segment.label} />
            : segment.label}
        </span>
      ))}
      {visibleUrl && ` · ${visibleUrl}`}
    </div>
  )
}

/** A click on the page's buttons and rows leaves the keyboard where it was:
 *  typing in the bar goes on, COMMAND stays COMMAND. */
const keepFocus = (e: React.MouseEvent): void => {
  // Not for what a dialog of its own (another window) bubbles up.
  if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return
  if (!(e.target instanceof HTMLElement && e.target.closest('input, textarea'))) e.preventDefault()
}

export function SearchPage({ tabId, windowWorkspaceId, vimMode, vimPending, hintsOn }: SearchPageProps) {
  const request = useSearchPageRequest()
  const [filter, setFilter] = useState<FilterType>(() =>
    request.v !== handledRequest ? request.filter ?? loadFilter() : shownFilter ?? loadFilter())
  const [scope, setScope] = useState<SearchScope>(loadScope)
  const [selected, setSelected] = useState(0)
  const [rowDialog, setRowDialog] = useState<RowDialog | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pickingRef = useRef(false)
  const rowMenuOpenRef = useRef(false)
  useEffect(() => { shownFilter = filter }, [filter])

  // The scope narrows what lives inside a workspace (tabs, groups) to the
  // window's own — typing or not: "This workspace" means this workspace.
  const scopeApplies = filter === 'tabGroup' || filter === 'tab'
  const scopedToCurrent = scopeApplies && scope === 'current' && !!windowWorkspaceId

  // Read again whenever what's there changes: a title loading, a tab closed
  // from the row menu.
  const profiles = useAppStore((s) => s.profiles)
  const allItems = useMemo(
    // This page's own tab (and another workspace's) is never a result.
    () => useAppStore.getState().getAllSearchableItems().filter((item) => internalPageOf(item.url) !== 'search'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profiles],
  )

  const inScope = useMemo(
    () => (scopedToCurrent ? allItems.filter((item) => item.workspaceId === windowWorkspaceId) : allItems),
    [allItems, scopedToCurrent, windowWorkspaceId],
  )
  const items = useMemo(() => inScope.filter((item) => item.type === filter), [inScope, filter])

  /** Each kind's count where it's searched, for the chips. */
  const counts = useMemo(() => {
    const out: Record<FilterType, number> = { profile: 0, workspace: 0, tabGroup: 0, tab: 0 }
    for (const item of allItems) {
      const scoped = (item.type === 'tab' || item.type === 'tabGroup') && scope === 'current' && !!windowWorkspaceId
      if (scoped && item.workspaceId !== windowWorkspaceId) continue
      out[item.type]++
    }
    return out
  }, [allItems, scope, windowWorkspaceId])

  const query = useAddressFilter('search', {
    label: TYPE_LABELS[filter],
    placeholder: placeholderFor(filter, scopeApplies && windowWorkspaceId ? scopedToCurrent : null),
    onKey: (e) => barKey(e),
    onEnter: () => openAt(selected),
  })

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 250)
    return fuzzyFilter(query, items, (item) => {
      // Combined haystack so queries can subsequence across path + url + comment
      // (path already contains profile / workspace / group / title).
      const haystack = [item.path, item.url, item.comment]
        .filter((s): s is string => !!s && s !== 'about:blank')
        .join(' ')
      return [
        { value: item.name, weight: 1 },
        { value: item.comment, weight: 0.9 },
        { value: item.url, weight: 0.5 },
        // The path carries the profile / workspace / group context, weighted
        // so a tab found by its workspace's or group's name ("jj" → "Jenkins
        // Jobs") comes up high, not under weak title coincidences.
        { value: item.path, weight: 0.7 },
        { value: haystack, weight: 0.5 },
      ]
    })
  }, [query, items])

  // A request (ot ow og op, the toolbar's search): its kind, typing at once.
  // The kind asked for isn't remembered as the one to open on next time.
  // Only a request takes the keyboard: the page shown again any other way
  // (a tab closed and this one picked, a click on its row, launch) leaves
  // COMMAND as it was, so the next keys aren't typed into the filter.
  useEffect(() => {
    if (request.v === handledRequest) return
    handledRequest = request.v
    setFilter(request.filter ?? loadFilter())
    // After the bar has turned into this page's filter (its layout effect,
    // then the toolbar's render) — and past the key that asked.
    const timers = [0, 80].map((ms) => setTimeout(() => {
      if (document.activeElement?.id !== 'url-bar') focusAddressFilter()
    }, ms))
    return () => timers.forEach(clearTimeout)
  }, [request.v, request.filter])

  useEffect(() => { setSelected(0) }, [query, filter, scope])
  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(results.length - 1, 0)))
  }, [results.length])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const moveBy = (delta: number): void => {
    setSelected((i) => Math.max(0, Math.min(results.length - 1, i + delta)))
  }

  const selectFilter = (next: FilterType): void => {
    setFilter(next)
    saveFilter(next)
  }
  const cycleFilter = (delta: number): void => {
    const at = FILTER_TYPES.indexOf(filter)
    selectFilter(FILTER_TYPES[(at + delta + FILTER_TYPES.length) % FILTER_TYPES.length])
  }
  const toggleScope = (): void => {
    setScope((prev) => {
      const next = prev === 'all' ? 'current' : 'all'
      saveScope(next)
      return next
    })
  }

  /** A key typed in the bar but Enter and Esc. */
  const barKey = (e: AddressFilterKeyEvent): boolean => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'Tab' && plain) {
      cycleFilter(e.shiftKey ? -1 : 1)
      return true
    }
    // Alt+S by its physical key (Option+S types ß on a Mac).
    const code = 'code' in e && typeof e.code === 'string' ? e.code : ''
    if (e.altKey && !e.ctrlKey && !e.metaKey && (code === 'KeyS' || e.key.toLowerCase() === 's')) {
      if (scopeApplies) toggleScope()
      return true
    }
    if (!plain || e.shiftKey) return false
    switch (e.key) {
      case 'ArrowDown': moveBy(1); return true
      case 'ArrowUp': moveBy(-1); return true
      case 'PageDown': moveBy(HALF_PAGE_ROWS); return true
      case 'PageUp': moveBy(-HALF_PAGE_ROWS); return true
    }
    return false
  }

  /** Goes where the result points; this page's tab closes behind it. */
  const pick = async (item: SearchableItem): Promise<void> => {
    if (pickingRef.current) return
    pickingRef.current = true
    log.action('search:select', { type: item.type, id: item.id, name: item.name })
    const store = useAppStore.getState()
    // In front, back to where the page was opened from; behind the result
    // just shown, only closed (lib/page-nav.ts).
    const closeSelf = (): void => { closePageTab(tabId) }
    const here = !!windowWorkspaceId && item.workspaceId === windowWorkspaceId

    // In this window: show it, then close the page — the closed tab isn't
    // the active one any more, so what's shown stays.
    if (item.type === 'tab' && here) {
      store.setActiveTab(item.id)
      closeSelf()
      return
    }
    const workspace = store.profiles
      .find((p) => p.id === item.profileId)
      ?.workspaces.find((w) => w.id === item.workspaceId)
    if (item.type === 'tabGroup' && here) {
      const group = workspace?.tabGroups.find((g) => g.id === item.tabGroupId)
      const firstTabId = group?.tabs.find((t) => t.id !== tabId)?.id
      if (firstTabId) store.setActiveTab(firstTabId)
      else if (group) store.setActiveGroup(group.id)
      closeSelf()
      return
    }

    // In a window of its own (or this one, brought up): the page closes
    // first, in its workspace — where you were shows again here, a group's
    // page too — so the state saved for that window no longer has it.
    closeSelf()
    try {
      if (item.type === 'profile') {
        const profile = useAppStore.getState().profiles.find((p) => p.id === item.profileId)
        if (!profile || profile.workspaces.length === 0) return
        await saveStateNow()
        // A window of the profile already open: the most recently active
        // one comes up; otherwise its last used workspace (or its first).
        const byId = new Map(profile.workspaces.map((w) => [w.id, w]))
        const openWindows = await window.electronAPI.getOpenWorkspaceWindows()
        const openWs = openWindows.map((entry) => byId.get(entry.workspaceId)).find((w) => w !== undefined)
        if (openWs) {
          window.electronAPI.openWorkspaceWindow(profile.id, openWs.id, openWs.name)
        } else {
          const lastUsedId = await window.electronAPI.getLastUsedWorkspace(profile.id)
          const ws = (lastUsedId && byId.get(lastUsedId)) || profile.workspaces[0]
          window.electronAPI.openWorkspaceWindow(profile.id, ws.id, ws.name)
        }
      } else if (item.type === 'workspace') {
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(item.profileId, item.workspaceId!, item.name)
      } else if (item.type === 'tabGroup') {
        const group = workspace?.tabGroups.find((g) => g.id === item.tabGroupId)
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(item.profileId, item.workspaceId!, workspace?.name || item.name, group?.tabs[0]?.id)
      } else {
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(item.profileId, item.workspaceId!, workspace?.name || item.name, item.id)
      }
    } catch (err) {
      log.warn('search: opening the result failed', { type: item.type, id: item.id, err: String(err) })
    }
  }

  /** Opens the row at `index`; false when there's none. */
  const openAt = (index: number): boolean => {
    const item = results[index]
    if (!item) return false
    void pick(item)
    return true
  }

  // ── The row menu (m in COMMAND, or a right-click) ──
  const runRowAction = (item: SearchableItem, actionId: string | null): void => {
    const s = useAppStore.getState()
    log.action('search:row-menu', { type: item.type, id: item.id, action: actionId })
    switch (actionId) {
      case 'close-tab': s.closeTab(item.id); break
      case 'duplicate-tab': s.duplicateItems([item.id]); break
      case 'move-tab':
        window.dispatchEvent(new CustomEvent('vimperium:open-move-tab', { detail: { tabIds: [item.id] } }))
        break
      case 'close-group': s.closeGroup(item.id); break
      case 'rename-group': setRowDialog({ kind: 'rename-group', id: item.id, name: item.name }); break
      case 'rename-workspace': setRowDialog({ kind: 'rename-workspace', id: item.id, name: item.name }); break
      case 'delete-workspace': {
        const ws = s.profiles.find((p) => p.id === item.profileId)?.workspaces.find((w) => w.id === item.id)
        const tabCount = ws ? (ws.tabs?.length ?? 0) + ws.tabGroups.reduce((n, g) => n + g.tabs.length, 0) : 0
        setRowDialog({ kind: 'delete-workspace', id: item.id, name: item.name, tabCount })
        break
      }
    }
  }

  const openRowMenu = async (item: SearchableItem, at: { x: number; y: number }, keyboard: boolean): Promise<void> => {
    if (rowMenuOpenRef.current) return
    const actions = rowMenuActions(item)
    if (actions.length === 0) return
    rowMenuOpenRef.current = true
    let actionId: string | null = null
    try {
      const result = await openDropdownAsync({
        kind: 'menu',
        position: { x: Math.round(at.x), y: Math.round(at.y) },
        ...readThemeAttrs(),
        header: item.name,
        actions,
        keyboard,
      })
      actionId = result?.type === 'action' ? result.actionId : null
    } catch (err) {
      log.warn('search: row menu failed', { err: String(err) })
    } finally {
      rowMenuOpenRef.current = false
    }
    runRowAction(item, actionId)
  }

  /** The selected row's menu, just under it past its icon. */
  const openSelectedRowMenu = (): void => {
    const item = results[selected]
    if (!item) return
    const rect = listRef.current?.querySelector(`[data-index="${selected}"]`)?.getBoundingClientRect()
    const at = rect ? { x: rect.left + 40, y: rect.bottom } : { x: window.innerWidth / 3, y: window.innerHeight / 4 }
    void openRowMenu(item, at, true)
  }

  // ── Vim COMMAND ──
  // Its rows' labels, picked by the window's keymap (App's useHintKeymap).
  useHintTargets('search-page', 0, vimMode === 'command' && hintsOn
    ? results.map((item) => ({
      id: hintId(item),
      name: item.name || item.url,
      activate: () => { void pick(item) },
    }))
    : null)
  const hintLabels = useHintLabels()

  usePageKeys({
    intercept: (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
      // Esc closes the page: the tab you were on shows again.
      if (e.key === 'Escape') return closePage('search')
      return keyTokenFromEvent(e) === '<CR>' && openAt(selected)
    },
    command: (command) => {
      switch (command) {
        case 'scroll-down': moveBy(1); return true
        case 'scroll-up': moveBy(-1); return true
        case 'half-page-down': moveBy(HALF_PAGE_ROWS); return true
        case 'half-page-up': moveBy(-HALF_PAGE_ROWS); return true
        case 'page-top': setSelected(0); return true
        case 'page-bottom': setSelected(Math.max(results.length - 1, 0)); return true
        case 'insert-mode':
        case 'focus-input':
          focusAddressFilter()
          return true
        // The selected result's, not the Sidebar's row's.
        case 'row-menu':
          openSelectedRowMenu()
          return true
      }
      return false
    },
  })

  // Without Vim mode: arrows, Enter and Esc outside the bar. (In Vim's
  // COMMAND they come through usePageKeys instead and never get this far.)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (vimMode || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return
    let handled = true
    if (e.key === 'ArrowDown') moveBy(1)
    else if (e.key === 'ArrowUp') moveBy(-1)
    else if (e.key === 'Enter') handled = openAt(selected)
    else if (e.key === 'Escape') handled = closePage('search')
    else handled = false
    if (handled) e.preventDefault()
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // What the row menu's rename and delete open.
  const renaming = rowDialog?.kind === 'rename-workspace' || rowDialog?.kind === 'rename-group' ? rowDialog : null
  const deleting = rowDialog?.kind === 'delete-workspace' ? rowDialog : null

  const TypeIcon = TYPE_ICONS[filter]
  const total = items.length
  const countLabel = query.trim() ? `${results.length}/${total}` : `${total}`

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background text-foreground select-none"
      role="region"
      aria-label="Search Everything"
      onMouseDown={keepFocus}
    >
      {/* Header: the title, then the kinds and the scope. */}
      <div className="shrink-0 border-b border-border">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-6 pt-5 pb-3">
          <Search size={18} className="shrink-0 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">Search Everything</h1>
        </div>
        <div className="mx-auto flex max-w-2xl items-center gap-1.5 px-6 pb-4">
          <div className="flex h-8 items-center rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="What to search">
            {FILTER_TYPES.map((type) => {
              const Icon = TYPE_ICONS[type]
              const active = filter === type
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={-1}
                  onClick={() => selectFilter(type)}
                  title={`${TYPE_LABELS[type]} (Tab / Shift+Tab in the address bar)`}
                  className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${
                    active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon size={13} />
                  {TYPE_LABELS[type]}
                  <span className="tabular-nums opacity-50">{counts[type]}</span>
                </button>
              )
            })}
          </div>
          {scopeApplies && windowWorkspaceId && (
            <button
              type="button"
              role="switch"
              aria-checked={scope === 'current'}
              tabIndex={-1}
              onClick={toggleScope}
              title={`Search this workspace or every one (${SCOPE_KEY_CAP} in the address bar)`}
              className="ml-auto flex h-7 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {scope === 'current' ? 'This workspace' : 'All workspaces'}
              <span
                className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                  scope === 'current' ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${
                    scope === 'current' ? 'translate-x-[10px]' : 'translate-x-0'
                  }`}
                />
              </span>
              <span className="opacity-50">{SCOPE_KEY_CAP}</span>
            </button>
          )}
        </div>
      </div>

      {/* The results: the same padding above and below, scrolled or not. */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-4 py-4" role="listbox" aria-label={TYPE_LABELS[filter]}>
          <div className="flex items-center gap-2 px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <TypeIcon size={10} />
            <span className="flex-1">{TYPE_LABELS[filter]}</span>
            <span className="tabular-nums">{countLabel}</span>
          </div>
          {results.length === 0 && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {query.trim() ? `Nothing matches “${query.trim()}”` : `No ${TYPE_LABELS[filter].toLowerCase()} here`}
            </p>
          )}
          {results.map((item, idx) => {
            const label = hintLabels.get(hintId(item))
            return (
              <div
                key={item.id}
                data-index={idx}
                role="option"
                aria-selected={idx === selected}
                data-group-container={item.groupColor ? '' : undefined}
                style={item.groupColor ? { ['--gc' as string]: item.groupColor } : undefined}
                onClick={() => { void pick(item) }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSelected(idx)
                  void openRowMenu(item, { x: e.clientX, y: e.clientY }, false)
                }}
                onMouseMove={() => { if (selected !== idx) setSelected(idx) }}
                className={`relative flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 ${
                  idx === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
              >
                {label && vimMode === 'command' && hintsOn && (
                  <RowHint mode="command" label={label} pending={vimPending} className="shrink-0 -my-px" />
                )}
                <span className="relative flex w-6 shrink-0 items-center">
                  {item.type === 'tab' ? (
                    <>
                      {item.groupColor && (
                        <span
                          aria-hidden="true"
                          className="absolute -left-1 h-4 w-0.5 rounded-full"
                          style={{ backgroundColor: 'var(--gc-resolved)' }}
                        />
                      )}
                      <TabFavicon favicon={item.favicon} />
                    </>
                  ) : (
                    <TypeIcon
                      size={16}
                      className="text-muted-foreground/60"
                      style={item.type === 'tabGroup' && item.groupColor ? { color: 'var(--gc-resolved)' } : undefined}
                    />
                  )}
                </span>
                {/* Single-cell grid: a profile's path is just its name, so it
                    has no breadcrumb — the invisible strut holds the row at
                    the height of a title and a breadcrumb all the same. */}
                <div className="grid min-w-0 flex-1 grid-cols-1">
                  {item.type === 'profile' && (
                    <div aria-hidden="true" className="invisible col-start-1 row-start-1">
                      <div className="text-sm">&nbsp;</div>
                      <div className="text-[10px]">&nbsp;</div>
                    </div>
                  )}
                  <div className="col-start-1 row-start-1 min-w-0 self-center">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {item.comment && <CommentChip comment={item.comment} />}
                      {item.type === 'tabGroup' && item.groupColor ? (
                        <GroupPill name={item.name} title={item.name} className="min-w-0 truncate text-sm" />
                      ) : (
                        <span className="min-w-title-stub flex-1 truncate text-sm" title={item.name}>
                          {item.name || item.url}
                        </span>
                      )}
                    </div>
                    {item.type !== 'profile' && <SearchBreadcrumb item={item} />}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <InputDialog
        open={renaming !== null}
        title={renaming?.kind === 'rename-group' ? 'Rename Group' : 'Rename Workspace'}
        placeholder={renaming?.kind === 'rename-group' ? 'Group name' : 'New workspace name'}
        defaultValue={renaming?.name ?? ''}
        confirmLabel="Rename"
        onConfirm={(name) => {
          if (renaming?.kind === 'rename-group') useAppStore.getState().renameTabGroup(renaming.id, name)
          else if (renaming) useAppStore.getState().renameWorkspace(renaming.id, name)
          log.action('search:rename', { kind: renaming?.kind, id: renaming?.id, name })
          setRowDialog(null)
        }}
        onCancel={() => setRowDialog(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete workspace "${deleting?.name ?? ''}"?`}
        message={`This will permanently delete ${deleting?.tabCount ?? 0} tab${deleting?.tabCount === 1 ? '' : 's'}. The workspace's window will be closed.`}
        onConfirm={() => {
          const target = deleting
          setRowDialog(null)
          if (!target) return
          log.action('search:delete-workspace', { id: target.id, name: target.name })
          // As the profile menu's Delete does: its window first, then the
          // workspace itself.
          void (async () => {
            try {
              await window.electronAPI.closeWorkspaceWindows([target.id])
              useAppStore.getState().removeWorkspace(target.id)
              await saveStateNow()
            } catch (err) {
              log.warn('search: deleting the workspace failed', { id: target.id, err: String(err) })
            }
          })()
        }}
        onCancel={() => setRowDialog(null)}
      />
    </div>
  )
}
