import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import { log } from '../lib/log'
import { fuzzyFilter } from '../lib/fuzzy'
import { Search, User, Layout, Layers, Globe } from 'lucide-react'
import type { SearchableItem } from '../store/types'
import { DetachedWindow } from './DetachedWindow'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'
import { GroupPill } from './GroupPill'
import { ScopeSwitch } from './ScopeSwitch'
import { InputField } from './InputField'
import { Hint, HintBar, LEAVE_INSERT_CAP, RowHint, vimKeyCaps } from './KeyHints'
import { hintIndex, usePopupHints } from '../lib/hint-labels'
import { usePopupVimMode, type VimMode } from '../lib/vim-mode'
import { displayKeySequence, keysFor, type VimKeymap } from '../lib/vim-keymap'
import { useWindowVimKeymap, withKeysOf } from '../lib/window-vim-keymap'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'
import { InputDialog } from './InputDialog'
import { ConfirmDialog } from './ConfirmDialog'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  windowWorkspaceId: string | null
  /** Vim mode's keymap for this window; null while Vim mode is off. */
  vimKeymap: VimKeymap | null
  /** The filter to open on (Vim's pick-* keys), without remembering it as
   *  the one the window opens on next time; null opens on the remembered one. */
  openFilter?: SearchFilter | null
}

/** Search commands from the Vim keymap → the filter they pick. */
const VIM_FILTER_COMMANDS: Record<string, FilterSelection> = {
  'search-profiles': 'profile',
  'search-workspaces': 'workspace',
  'search-groups': 'tabGroup',
  'search-tabs': 'tab',
}
const VIM_FILTER_COMMAND_BY_TYPE: Record<FilterType, string> = {
  profile: 'search-profiles',
  workspace: 'search-workspaces',
  tabGroup: 'search-groups',
  tab: 'search-tabs',
}

const TYPE_ICONS: Record<string, typeof User> = {
  profile: User,
  workspace: Layout,
  tabGroup: Layers,
  tab: Globe,
}

const TYPE_LABELS: Record<string, string> = {
  profile: 'Profiles',
  workspace: 'Workspaces',
  tabGroup: 'Tab Groups',
  tab: 'Tabs',
}

const FILTER_TYPES = ['profile', 'workspace', 'tabGroup', 'tab'] as const

type FilterType = (typeof FILTER_TYPES)[number]

/** Each filter's mnemonic hotkey — Ctrl/⌘ plus its initial — alongside the
 *  positional Ctrl/⌘ + digit. Matched by physical key, so they work on any
 *  keyboard layout. */
const FILTER_LETTERS: Record<FilterType, string> = {
  profile: 'P',
  workspace: 'W',
  tabGroup: 'G',
  tab: 'T',
}

/** Exclusive filter selection — exactly one item type. */
type FilterSelection = FilterType
export type SearchFilter = FilterSelection

/** Where tab groups / tabs are searched: every workspace or only the one this window shows. */
type SearchScope = 'all' | 'current'

const FILTER_STORAGE_KEY = 'vimperium-search-filter'
const SCOPE_STORAGE_KEY = 'vimperium-search-scope'

/** The filter picked last; tabs at first (a stale "all" too). */
function loadFilter(): FilterSelection {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY)
    if ((FILTER_TYPES as readonly string[]).includes(raw ?? '')) return raw as FilterSelection
  } catch { /* no storage: the default */ }
  return 'tab'
}

function saveFilter(filter: FilterSelection) {
  localStorage.setItem(FILTER_STORAGE_KEY, filter)
}

function loadScope(): SearchScope {
  // Default to the window's own workspace — searching tabs/groups usually means
  // "find something in what I'm looking at" rather than across every profile.
  return localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'current'
}

function saveScope(scope: SearchScope) {
  localStorage.setItem(SCOPE_STORAGE_KEY, scope)
}

function SearchBreadcrumb({ item }: { item: SearchableItem }) {
  const visibleUrl = item.url && item.url !== 'about:blank' ? item.url : undefined
  const fullLabel = `${item.path}${visibleUrl ? ` · ${visibleUrl}` : ''}`
  // A group's own row already wears the colour on its label, so the group
  // crumb is only a pill where the label is something else (a tab).
  const pillGroupCrumb = !!item.groupColor && item.type !== 'tabGroup'

  return (
    <div className="text-[10px] text-muted-foreground truncate" title={fullLabel}>
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

const isMac = navigator.platform.includes('Mac')
const MOD = isMac ? '⌘' : 'Ctrl+'

/** The theme for the row menu's popup (its own window). */
function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

/** A row menu's follow-up that needs a dialog of its own, Search closed. */
type RowDialog =
  | { kind: 'rename-workspace'; id: string; name: string }
  | { kind: 'rename-group'; id: string; name: string }
  | { kind: 'delete-workspace'; id: string; name: string; tabCount: number }

/** What a row's menu (<C-m> in COMMAND) offers, with a key each — the
 *  Sidebar's letters where it has the same action. */
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

export function SearchDialog({ open, onOpenChange, windowWorkspaceId, vimKeymap, openFilter = null }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filter, setFilter] = useState<FilterSelection>(loadFilter)
  const [scope, setScope] = useState<SearchScope>(loadScope)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  // Vim mode (null while off): the window opens in INSERT, typing in the
  // search box; Ctrl+C goes to COMMAND, where plain keys pick filters and
  // rows; Esc closes from either.
  // Follows the box's focus. Set up further down, once its commands exist; the
  // handlers above only need to know which mode it's in.
  const vimModeRef = useRef<VimMode | null>(null)
  // The row menu (<C-m>): bumped after it changed what the results hold, so
  // they're read again; the menu being open, during which the window losing
  // focus to it mustn't close it; and the window's key, changed to open it
  // anew once the menu's gone — the way to give it the keyboard back.
  const [revision, setRevision] = useState(0)
  const rowMenuOpenRef = useRef(false)
  const [windowKey, setWindowKey] = useState(0)
  const [rowDialog, setRowDialog] = useState<RowDialog | null>(null)

  const getAllSearchableItems = useAppStore((s) => s.getAllSearchableItems)
  const setActiveTab = useAppStore((s) => s.setActiveTab)

  // The workspace scope narrows item types that live inside a workspace
  // (tabs / tab groups) down to the window's own workspace. It's an explicit,
  // user-controlled toggle (Tab), so we honour it both while BROWSING (empty
  // query) and while TYPING a search — "This workspace" must mean this workspace
  // in both cases, otherwise typing a single character silently throws the
  // toggle away. To search a tab across every workspace (e.g. "jj" → a tab under
  // the "Jenkins Jobs" workspace from elsewhere), flip the toggle to
  // "All workspaces".
  const scopeApplies = filter === 'tabGroup' || filter === 'tab'
  const scopedToCurrent = scopeApplies && scope === 'current' && !!windowWorkspaceId

  const items = useMemo(() => {
    const all = getAllSearchableItems()
    const typed = all.filter((item) => item.type === filter)
    if (scopedToCurrent) {
      return typed.filter((item) => item.workspaceId === windowWorkspaceId)
    }
    return typed
    // revision: the row menu changed what's there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getAllSearchableItems, open, filter, scopedToCurrent, windowWorkspaceId, revision])

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
        // The path carries the profile / workspace / group context. Weight it
        // high enough that matching a tab purely by its workspace/group name
        // (e.g. "jj" → "Jenkins Jobs") surfaces the tab prominently, not buried
        // beneath weak title coincidences.
        { value: item.path, weight: 0.7 },
        { value: haystack, weight: 0.5 },
      ]
    })
  }, [query, items])

  // Count totals per type within the active scope (not just visible results)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allItems = useMemo(() => getAllSearchableItems(), [getAllSearchableItems, open, revision])
  const totalCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of allItems) {
      if (scopedToCurrent && item.workspaceId !== windowWorkspaceId) continue
      counts[item.type] = (counts[item.type] || 0) + 1
    }
    return counts
  }, [allItems, scopedToCurrent, windowWorkspaceId])

  const grouped = useMemo(() => {
    const groups: Record<string, SearchableItem[]> = {}
    for (const item of results) {
      if (!groups[item.type]) groups[item.type] = []
      groups[item.type].push(item)
    }
    return groups
  }, [results])

  const flatResults = useMemo(() => {
    const flat: SearchableItem[] = []
    for (const type of FILTER_TYPES) {
      if (grouped[type]) flat.push(...grouped[type])
    }
    return flat
  }, [grouped])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setFilter(openFilter ?? loadFilter())
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, filter, scope])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const selectFilter = useCallback((selection: FilterSelection) => {
    setFilter(selection)
    saveFilter(selection)
    // Chip clicks move focus to the button; pull it back so typing and the
    // filter hotkeys keep working. No-op when invoked from the keyboard.
    // In Vim's COMMAND mode the keys work without it.
    if (vimModeRef.current !== 'command') inputRef.current?.focus()
  }, [])

  const toggleScope = useCallback(() => {
    setScope((prev) => {
      const next = prev === 'all' ? 'current' : 'all'
      saveScope(next)
      return next
    })
    if (vimModeRef.current !== 'command') inputRef.current?.focus()
  }, [])

  const handleSelect = useCallback(async (item: SearchableItem) => {
    log.action('search:select', { type: item.type, id: item.id, name: item.name })

    if (item.type === 'profile') {
      const profiles = useAppStore.getState().profiles
      const profile = profiles.find((p) => p.id === item.profileId)
      if (profile && profile.workspaces.length > 0) {
        await saveStateNow()
        // If any window of this profile is already open, focus the
        // most-recently-active one; otherwise open exactly one workspace —
        // the last used (falling back to the first).
        const byId = new Map(profile.workspaces.map((w) => [w.id, w]))
        const openWindows = await window.electronAPI.getOpenWorkspaceWindows()
        const openWs = openWindows
          .map((entry) => byId.get(entry.workspaceId))
          .find((w) => w !== undefined)
        if (openWs) {
          window.electronAPI.openWorkspaceWindow(profile.id, openWs.id, openWs.name)
        } else {
          const lastUsedId = await window.electronAPI.getLastUsedWorkspace(profile.id)
          const ws = (lastUsedId && byId.get(lastUsedId)) || profile.workspaces[0]
          window.electronAPI.openWorkspaceWindow(profile.id, ws.id, ws.name)
        }
      }
    } else if (item.type === 'workspace') {
      await saveStateNow()
      window.electronAPI.openWorkspaceWindow(item.profileId, item.workspaceId!, item.name)
    } else if (item.type === 'tabGroup') {
      const profiles = useAppStore.getState().profiles
      const profile = profiles.find((p) => p.id === item.profileId)
      const workspace = profile?.workspaces.find((w) => w.id === item.workspaceId)
      const group = workspace?.tabGroups.find((g) => g.id === item.tabGroupId)
      const firstTabId = group?.tabs[0]?.id

      if (item.workspaceId === windowWorkspaceId) {
        if (firstTabId) setActiveTab(firstTabId)
      } else {
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(
          item.profileId,
          item.workspaceId!,
          workspace?.name || item.name,
          firstTabId,
        )
      }
    } else if (item.type === 'tab') {
      if (item.workspaceId === windowWorkspaceId) {
        setActiveTab(item.id)
      } else {
        const profiles = useAppStore.getState().profiles
        const workspace = profiles
          .find((p) => p.id === item.profileId)
          ?.workspaces.find((w) => w.id === item.workspaceId)
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(
          item.profileId,
          item.workspaceId!,
          workspace?.name || item.name,
          item.id,
        )
      }
    }
    onOpenChange(false)
  }, [windowWorkspaceId, setActiveTab, onOpenChange])

  function codeToDigit(code: string): number | null {
    const m = code.match(/^Digit(\d)$/)
    return m ? parseInt(m[1], 10) : null
  }

  /** Filter hotkeys: ⌘ on Mac, Ctrl on Windows/Linux. True when handled.
   *  Off in Vim mode, like every regular shortcut — its letters pick filters. */
  const handleFilterChord = useCallback((e: KeyboardEvent | React.KeyboardEvent): boolean => {
    if (vimKeymap) return false
    // Excluding the other platform's modifier (incl. Alt on Windows) keeps
    // AltGr (Ctrl+Alt) out.
    const mod = isMac ? e.metaKey : e.ctrlKey
    const otherMod = isMac ? e.altKey || e.ctrlKey : e.metaKey || e.altKey

    if (mod && !otherMod) {
      const digit = codeToDigit(e.code)
      if (digit !== null && digit >= 1 && digit <= FILTER_TYPES.length) {
        e.preventDefault()
        selectFilter(FILTER_TYPES[digit - 1])
        return true
      }
      // The letters overlap app-wide shortcuts (Ctrl+P search, Ctrl+W close
      // tab, Ctrl+T new tab). Popups get no main-process shortcut
      // interceptor, and handling the key here keeps the menu accelerator
      // from firing.
      // Shifted variants (Ctrl+Shift+P/W/T) are other commands; leave them be.
      const lettered = e.shiftKey
        ? undefined
        : FILTER_TYPES.find((type) => e.code === `Key${FILTER_LETTERS[type]}`)
      if (lettered) {
        e.preventDefault()
        selectFilter(lettered)
        return true
      }
    }
    return false
  }, [selectFilter, vimKeymap])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (handleFilterChord(e)) return

    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Keep focus in the search input; Tab is the scope toggle here.
      e.preventDefault()
      if (scopeApplies) toggleScope()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flatResults[selectedIndex]) handleSelect(flatResults[selectedIndex])
    } else if (e.key === 'Escape') {
      // In Vim mode Esc never gets here: the window's Vim keys close it
      // (usePopupVimMode), from the box as from COMMAND.
      onOpenChange(false)
    }
  }, [flatResults, selectedIndex, handleSelect, onOpenChange, toggleScope, scopeApplies, handleFilterChord])

  // ── The row menu (<C-m>) ──
  // The window's row-menu key opens the menu of the row under the cursor,
  // the dropdown the Sidebar's rows have, keyboard and all: close, move or
  // duplicate a tab; rename or close a group; rename or delete a workspace.
  // The menu takes the keyboard (its own window), so this one stays open
  // under it and opens anew afterwards — unless what was picked needs a
  // dialog, which this one gives way to.
  const parsedKeymap = useWindowVimKeymap()
  const searchKeymap = useMemo(
    () => (vimKeymap && parsedKeymap ? withKeysOf(vimKeymap, parsedKeymap.main, ['row-menu'], 'row-menu') : vimKeymap),
    [vimKeymap, parsedKeymap],
  )
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(flatResults.length - 1, 0)))
  }, [flatResults.length])

  const runRowAction = (item: SearchableItem, actionId: string | null): void => {
    const s = useAppStore.getState()
    // Done here, then back to the results, read again.
    const thenBack = (): void => {
      setRevision((r) => r + 1)
      setWindowKey((k) => k + 1)
    }
    // Needs a window of its own: this one closes first, the way the Command
    // Palette's actions run once it's gone.
    const handOff = (run: () => void): void => {
      onOpenChange(false)
      setTimeout(run, 100)
    }
    log.action('search:row-menu', { type: item.type, id: item.id, action: actionId })
    switch (actionId) {
      case 'close-tab': s.closeTab(item.id); thenBack(); break
      case 'duplicate-tab': s.duplicateItems([item.id]); thenBack(); break
      case 'move-tab':
        handOff(() => window.dispatchEvent(new CustomEvent('vimperium:open-move-tab', { detail: { tabIds: [item.id] } })))
        break
      case 'close-group': s.closeGroup(item.id); thenBack(); break
      case 'rename-group':
        handOff(() => setRowDialog({ kind: 'rename-group', id: item.id, name: item.name }))
        break
      case 'rename-workspace':
        handOff(() => setRowDialog({ kind: 'rename-workspace', id: item.id, name: item.name }))
        break
      case 'delete-workspace': {
        const ws = s.profiles.find((p) => p.id === item.profileId)?.workspaces.find((w) => w.id === item.id)
        const tabCount = ws ? (ws.tabs?.length ?? 0) + ws.tabGroups.reduce((n, g) => n + g.tabs.length, 0) : 0
        handOff(() => setRowDialog({ kind: 'delete-workspace', id: item.id, name: item.name, tabCount }))
        break
      }
      default:
        // Esc: back to the results as they were.
        setWindowKey((k) => k + 1)
    }
  }

  const openRowMenu = async (): Promise<void> => {
    const item = flatResults[selectedIndex]
    if (!item || rowMenuOpenRef.current) return
    const actions = rowMenuActions(item)
    if (actions.length === 0) return
    // Just under the row, past its icon — from this window's corner to the
    // browser window's, which the menu is placed in.
    const row = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    const rect = row?.getBoundingClientRect()
    const position = popupWindow && rect
      ? { x: Math.round(popupWindow.screenX + rect.left + 40 - window.screenX), y: Math.round(popupWindow.screenY + rect.bottom - window.screenY) }
      : { x: Math.round(window.innerWidth / 3), y: Math.round(window.innerHeight / 4) }
    rowMenuOpenRef.current = true
    let actionId: string | null = null
    try {
      const result = await openDropdownAsync({
        kind: 'menu',
        position,
        ...readThemeAttrs(),
        header: item.name,
        actions,
        keyboard: true,
      })
      actionId = result?.type === 'action' ? result.actionId : null
    } finally {
      rowMenuOpenRef.current = false
    }
    runRowAction(item, actionId)
  }

  // ── Vim COMMAND mode ──
  // COMMAND mode's row labels (lib/hint-labels.ts).
  const hints = usePopupHints(searchKeymap, flatResults.map((item) => item.name))
  const runVimCommand = (command: string): void => {
    if (command === 'row-menu') {
      openRowMenu().catch((err: unknown) => log.warn('search: row menu failed', { err: String(err) }))
      return
    }
    const hinted = hintIndex(command)
    if (hinted !== null) {
      const item = flatResults[hinted]
      if (item) handleSelect(item)
      return
    }
    const filterPick = VIM_FILTER_COMMANDS[command]
    if (filterPick) {
      selectFilter(filterPick)
      return
    }
    const row = /^search-row-(\d)$/.exec(command)
    if (row) {
      const item = flatResults[Number(row[1]) - 1]
      if (item) handleSelect(item)
      return
    }
    switch (command) {
      case 'search-scope': if (scopeApplies) toggleScope(); break
      case 'insert-mode': inputRef.current?.focus(); break
      case 'cursor-down': setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1)); break
      case 'cursor-up': setSelectedIndex((i) => Math.max(i - 1, 0)); break
      case 'cursor-first': setSelectedIndex(0); break
      case 'cursor-last': setSelectedIndex(Math.max(flatResults.length - 1, 0)); break
      case 'row-open': if (flatResults[selectedIndex]) handleSelect(flatResults[selectedIndex]); break
    }
  }
  const vim = usePopupVimMode({
    keymap: hints.keymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'insert',
    open,
    onCommand: runVimCommand,
    onEscape: () => onOpenChange(false),
  })
  vimModeRef.current = vim.mode
  const vimMode = vim.mode

  /** How a command is bound, for the filter chips: "a", "j/k". */
  const vimHint = (...commands: string[]): string =>
    vimKeymap ? commands.map((c) => keysFor(vimKeymap, c)[0]).filter(Boolean).map(displayKeySequence).join('/') : ''

  // What the row menu's rename and delete open, once this window's gone —
  // so they're here even while it's closed.
  const renaming = rowDialog?.kind === 'rename-workspace' || rowDialog?.kind === 'rename-group' ? rowDialog : null
  const deleting = rowDialog?.kind === 'delete-workspace' ? rowDialog : null
  const rowDialogs = (
    <>
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
    </>
  )

  if (!open) return rowDialogs

  let flatIdx = 0

  return (
    <>
    {rowDialogs}
    <DetachedWindow
      // A new key opens the window anew, which gives it the keyboard back
      // after the row menu had it.
      key={windowKey}
      open={open}
      title="Search - Vimperium"
      width={760}
      height={640}
      closeOnBlur
      matchRunwaPalette
      // In Vim mode Esc is the window's Vim keys' (usePopupVimMode), which close it.
      closeOnEscape={!vimKeymap}
      // Not while the row menu has the keyboard: it took it from here.
      onClose={() => { if (!rowMenuOpenRef.current) onOpenChange(false) }}
      onWindowChange={setPopupWindow}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="px-4 py-2.5 border-b border-border shrink-0"
        >
          <InputField inputRef={inputRef} mode={vimMode} pending={vim.pending} className="h-10">
            <Search size={16} className="shrink-0 text-muted-foreground" />
            <input
              data-detached-drag-handle
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={vim.onBoxFocus}
              onBlur={vim.onBoxBlur}
              placeholder={vimMode === 'command' && vimHint('insert-mode')
                ? `Search everything... (${vimHint('insert-mode')} to type)`
                : 'Search everything...'}
              className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
            />
          </InputField>
        </div>

        <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0">
          {FILTER_TYPES.map((type, i) => {
            const Icon = TYPE_ICONS[type]
            const active = filter === type
            return (
              <button
                key={type}
                onClick={() => selectFilter(type)}
                className={`flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-secondary text-muted-foreground border border-transparent hover:bg-accent'
                }`}
              >
                <Icon size={10} />
                {TYPE_LABELS[type]}
                {/* The letter shares the digit's modifier. Spelling it out
                    ("Ctrl+1/Ctrl+P") overflows the row once the scope switch
                    shows, so the footer carries the explicit form. */}
                <span className="opacity-50 ml-0.5">
                  {vimKeymap ? vimHint(VIM_FILTER_COMMAND_BY_TYPE[type]) : `${MOD}${i + 1}/${FILTER_LETTERS[type]}`}
                </span>
              </button>
            )
          })}
          {scopeApplies && (
            <ScopeSwitch
              on={scope === 'current'}
              label={scope === 'current' ? 'This workspace' : 'All workspaces'}
              onToggle={toggleScope}
              title="Toggle search scope (Tab)"
              className="ml-auto"
            />
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
          {flatResults.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results found
            </div>
          ) : (
            FILTER_TYPES.map((type) => {
              const groupItems = grouped[type]
              if (!groupItems || groupItems.length === 0) return null
              const TypeIcon = TYPE_ICONS[type] || Globe
              const visibleCount = groupItems.length
              const totalCount = totalCounts[type] || visibleCount
              const countLabel = query.trim() ? `${visibleCount}/${totalCount}` : `${totalCount}`
              return (
                <div key={type}>
                  <div className="px-4 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <span className="w-6 shrink-0" />
                    <span className="flex-1 flex items-center gap-1"><TypeIcon size={10} /> {TYPE_LABELS[type] || type}</span>
                    <span className="w-8 text-right">{countLabel}</span>
                  </div>
                  {groupItems.map((item) => {
                    const idx = flatIdx++
                    return (
                      <div
                        key={item.id}
                        data-index={idx}
                        data-group-container={item.groupColor ? '' : undefined}
                        style={item.groupColor ? { ['--gc' as string]: item.groupColor } : undefined}
                        className={`relative flex items-center gap-2 px-4 py-2 cursor-pointer ${
                          idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        }`}
                        onClick={() => handleSelect(item)}
                      >
                        <RowHint mode={vimMode} label={hints.labels[idx]} pending={vim.pending} className="absolute left-0 top-1/2 -translate-y-1/2" />
                        <span className="relative w-6 shrink-0 flex items-center">
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
                              style={item.type === 'tabGroup' && item.groupColor
                                ? { color: 'var(--gc-resolved)' }
                                : undefined}
                            />
                          )}
                        </span>
                        {/* Single-cell grid: both children sit in row 1 and
                            overlap. A profile's path is just the profile name,
                            so its breadcrumb would only echo the title — but
                            dropping a line must not shorten the row. The
                            invisible strut below reproduces the title +
                            breadcrumb line boxes (same font sizes, hence the
                            same heights) to hold the row at its normal height,
                            and the real content centres itself against it. */}
                        <div className="flex-1 min-w-0 grid grid-cols-1">
                          {item.type === 'profile' && (
                            <div aria-hidden="true" className="col-start-1 row-start-1 invisible">
                              <div className="text-sm">&nbsp;</div>
                              <div className="text-[10px]">&nbsp;</div>
                            </div>
                          )}
                          {/* col-start-1 on BOTH children is what makes them
                              overlap. Without it the second one is auto-placed
                              into an implicit second column and gets pushed to
                              the right of the strut. */}
                          <div className="col-start-1 row-start-1 min-w-0 self-center">
                            <div className="flex min-w-0 items-center gap-1.5">
                              {item.comment && <CommentChip comment={item.comment} />}
                              {item.type === 'tabGroup' && item.groupColor ? (
                                <GroupPill name={item.name} title={item.name} className="min-w-0 truncate text-sm" />
                              ) : (
                                <span className="min-w-title-stub flex-1 truncate text-sm" title={item.name}>
                                  {item.name}
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
              )
            })
          )}
        </div>
        {/* The keys, along the bottom as everywhere. */}
        <div data-detached-drag-handle>
          {vim.showKeys && vimMode === 'command' && (
<HintBar>
            {vimMode === 'command' ? (
              <>
                <Hint label="Navigate" keys={vimKeyCaps(vimKeymap, 'cursor-down', 'cursor-up')} />
                <Hint label="Open" keys={vimKeyCaps(vimKeymap, 'row-open')} />
                {hints.labels[0] && <Hint label="Open row" keys={[`${hints.labels[0]}…`]} />}
                {flatResults[selectedIndex] && flatResults[selectedIndex].type !== 'profile' && (
                  <Hint label="Menu" keys={vimKeyCaps(searchKeymap, 'row-menu')} />
                )}
                <Hint label="Filter" keys={vimKeyCaps(vimKeymap, 'search-profiles', 'search-workspaces', 'search-groups', 'search-tabs')} />
                {scopeApplies && <Hint label="Scope" keys={vimKeyCaps(vimKeymap, 'search-scope')} />}
                <Hint label="Type" keys={vimKeyCaps(vimKeymap, 'insert-mode')} />
                <Hint label="Close" keys={['Esc']} />
              </>
            ) : (
              <>
                <Hint label="Navigate" keys={['↓', '↑']} />
                <Hint label="Open" keys={['Enter']} />
                {/* The filter chords are regular shortcuts — off in Vim mode,
                    where COMMAND mode's letters pick filters instead. */}
                {!vimMode && (
                  <>
                    <Hint label="Filter" keys={[isMac ? '⌘' : 'Ctrl', '1…4']} />
                    <Hint label="or" keys={[isMac ? '⌘' : 'Ctrl', FILTER_TYPES.map((type) => FILTER_LETTERS[type]).join(' ')]} />
                  </>
                )}
                {scopeApplies && <Hint label="Scope" keys={['Tab']} />}
                {vimMode === 'insert' && <Hint label="Command mode" keys={[LEAVE_INSERT_CAP]} />}
                <Hint label="Close" keys={['Esc']} />
              </>
            )}
          </HintBar>
)}
        </div>
      </div>
    </DetachedWindow>
    </>
  )
}
