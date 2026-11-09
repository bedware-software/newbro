// The Bookshelf as a page (vimperium://bookshelf, tb): this profile's reading
// list — readings to read, in groups if you like, and an archive of the ones
// read — drawn in the page area as Downloads and Bangs are.
//
// The address bar is its filter (lib/address-filter.ts): what's typed there
// narrows the readings by title and address, their groups' headings kept;
// ↑/↓ move through the rows and Enter opens the selected one.
//
// Vim mode: in COMMAND the window's keymap runs, and the page takes the keys
// it has a meaning for (lib/vim-mode.ts usePageKeys) — j/k, <C-d>/<C-u>,
// gg/G move the selection, h/l fold and unfold, Enter opens a reading in a
// new tab (Shift+Enter: behind this one), <C-j>/<C-k> move the selected row,
// m is its menu, dd archives a reading (removes an archived one, deletes a
// group), dg deletes the group, u undoes the last dd, y copies the reading's
// address, ng makes a group of it, nb adds the page you were on; i and gi
// type in the filter. Each row wears a label that picks it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive, ArchiveRestore, BookOpen, ChevronDown, ChevronRight, Download, FolderMinus, FolderPlus,
  Loader2, Pencil, Plus, Trash2, WifiOff, X,
} from 'lucide-react'
import { getSidebarOrder, useAppStore, type AppState } from '../store/app-store'
import type { Tab } from '../store/types'
import type { Reading, ReadingGroup, ReadingStatus } from './Bookshelf'
import { TabFavicon } from './TabFavicon'
import { InlineRenameInput } from './InlineRenameInput'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'
import { MoveBookshelfDialog, type BookshelfMoveTarget } from './MoveBookshelfDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { KeyCap, RowHint, vimKeyCaps } from './KeyHints'
import { useHintLabels, useHintTargets } from '../lib/hint-labels'
import { usePageKeys } from '../lib/vim-mode'
import { focusAddressFilter, useAddressFilter, type AddressFilterKeyEvent } from '../lib/address-filter'
import { closePage } from '../lib/page-nav'
import { isInternalUrl } from '../lib/internal-pages'
import { fuzzyFilter } from '../lib/fuzzy'
import { keyTokenFromEvent } from '../lib/vim-keymap'
import { log } from '../lib/log'
import type { VimKeymap } from '../lib/vim-keymap'
import type { VimMode } from '../lib/vim-mode'

export interface BookshelfPageProps {
  /** The profile this window belongs to: its shelf is the one shown. */
  profileId: string | null
  vimKeymap: VimKeymap | null
  vimMode: VimMode | null
  vimPending: string
  hintsOn: boolean
}

// ── The page you were on ──
// The Bookshelf is a tab of its own, so while it shows, the active tab is
// the shelf — "add the current page" (+, nb) means the page you were on
// before it: the workspace's most recently active tab that's a web page.
// Watched from the moment this module loads (WebviewPanel imports it at
// start), per workspace.

const lastWebTabByWorkspace = new Map<string, string>()
// The active tab and whether it showed an internal page, as last seen: a
// tab keeps its id when an internal page in it (Downloads, a new tab's
// page) goes to an address typed in the bar, so the id alone would miss it
// becoming a web page.
let watchedKey: string | null = null

function noteActiveTab(s: AppState): void {
  const tab = s.activeWorkspaceId && s.activeTabId ? s.getActiveTab() : undefined
  const key = tab ? `${tab.id}|${isInternalUrl(tab.url) ? 'i' : 'w'}` : null
  if (key === watchedKey) return
  watchedKey = key
  if (tab && s.activeWorkspaceId && !isInternalUrl(tab.url)) lastWebTabByWorkspace.set(s.activeWorkspaceId, tab.id)
}
noteActiveTab(useAppStore.getState())
useAppStore.subscribe(noteActiveTab)

/** A tab whose page is worth adding: a web page with a real address. */
function isWebPage(tab: Tab): boolean {
  return !isInternalUrl(tab.url) && !!tab.url && tab.url !== 'about:blank'
}

/** The web page the active workspace showed last (the tab you were on
 *  before the Bookshelf, Downloads…), if it's still there and has an
 *  address worth keeping. When it isn't — closed since, or never seen
 *  because the app started on the Bookshelf — the workspace's first web
 *  page in Sidebar order, so + and nb still add something real. */
export function lastWebTab(s: AppState): Tab | null {
  const workspaceId = s.activeWorkspaceId
  if (!workspaceId) return null
  for (const p of s.profiles) {
    const w = p.workspaces.find((x) => x.id === workspaceId)
    if (!w) continue
    const tabs = w.tabs ?? []
    const id = lastWebTabByWorkspace.get(workspaceId)
    if (id) {
      const tab = tabs.find((t) => t.id === id) ?? w.tabGroups.flatMap((g) => g.tabs).find((t) => t.id === id)
      if (tab && isWebPage(tab)) return tab
    }
    const tabById = new Map(tabs.map((t) => [t.id, t]))
    const groupById = new Map(w.tabGroups.map((g) => [g.id, g]))
    for (const rowId of getSidebarOrder(w)) {
      const tab = tabById.get(rowId)
      if (tab) {
        if (isWebPage(tab)) return tab
        continue
      }
      const inGroup = groupById.get(rowId)?.tabs.find(isWebPage)
      if (inGroup) return inGroup
    }
    // Rows the order doesn't list yet: the ungrouped tabs, then the groups'.
    return tabs.find(isWebPage) ?? w.tabGroups.flatMap((g) => g.tabs).find(isWebPage) ?? null
  }
  return null
}

// ── Helpers ──

/** Mirror the parent's theme attrs onto the dropdown popup (its own window). */
function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

/** Where a context menu opens, in window content coordinates. */
interface MenuPoint {
  x: number
  y: number
}

/** A right-click's menu position; also keeps the native menu from opening. */
function contextMenuPoint(e: React.MouseEvent): MenuPoint {
  e.preventDefault()
  e.stopPropagation()
  return { x: e.clientX, y: e.clientY }
}

/** Win keyboard focus back for the renderer after a popup (a row menu)
 *  closes: the OS may hand it to the hidden tab view first. */
function reclaimRendererFocus(): void {
  window.electronAPI?.reclaimWindowRendererFocus?.()
  for (const delay of [60, 180]) {
    setTimeout(() => {
      if (!document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
    }, delay)
  }
}

const ARCHIVE_ROW_ID = '__archive__'
/** Container key of the To Read list's ungrouped readings. Group containers
 *  are keyed by group id, the archive by ARCHIVE_ROW_ID. */
const UNGROUPED = '__ungrouped__'

/** What's being dragged: readings (the selection, in display order) or a group. */
type ShelfDrag =
  | { type: 'reading'; ids: string[] }
  | { type: 'group'; id: string }

/** Where a drag lands. Readings go into a container right before `beforeId`
 *  (its end when null); `into` marks a drop on the container's header or empty
 *  placeholder rather than between rows. Groups go before another group. */
type ShelfDrop =
  | { type: 'reading'; container: string; beforeId: string | null; into: boolean }
  | { type: 'group'; beforeId: string | null }

/** The place-readings target for a container key. */
function placeTarget(container: string): { groupId: string | null; archived?: boolean } {
  if (container === ARCHIVE_ROW_ID) return { groupId: null, archived: true }
  return { groupId: container === UNGROUPED ? null : container }
}

/** The drop-position line, like the sidebar's. */
function DropLine() {
  return <div className="absolute left-1 right-1 -top-px h-[3px] bg-primary rounded-full z-10 pointer-events-none" />
}

/** The drop line after a container's last row. */
function EndDropLine() {
  return <div className="relative h-0"><DropLine /></div>
}

/** A row the selection can sit on, in the order they're drawn. */
type ShelfRow =
  | { kind: 'reading'; id: string; reading: Reading; container: string }
  | { kind: 'group'; id: string; group: ReadingGroup }
  | { kind: 'archive'; id: string }

/** What u brings back: a reading dd archived (to where it was), or an
 *  archived one dd removed. */
type ShelfUndo =
  | { kind: 'archived'; id: string; groupId: string | null; beforeId: string | null }
  | { kind: 'removed'; reading: Reading; beforeId: string | null }

/** A row's id among the window's hint targets: one reading, one label. */
const hintId = (row: ShelfRow): string =>
  row.kind === 'reading' ? `reading:${row.id}` : row.kind === 'group' ? `shelf-group:${row.id}` : 'shelf-archive'

/** The shelf as shown: its sections, each with the readings the filter
 *  leaves, and whether it's unfolded. */
interface ShelfView {
  ungrouped: Reading[]
  groups: { group: ReadingGroup; items: Reading[]; all: number; open: boolean }[]
  archived: Reading[]
  archiveOpen: boolean
}

export function BookshelfPage({ profileId, vimKeymap, vimMode, vimPending, hintsOn }: BookshelfPageProps) {
  const [readings, setReadings] = useState<Reading[]>([])
  const [groups, setGroups] = useState<ReadingGroup[]>([])
  const [loaded, setLoaded] = useState(false)
  const [archiveCollapsed, setArchiveCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupEditValue, setGroupEditValue] = useState('')
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [moveTarget, setMoveTarget] = useState<BookshelfMoveTarget | null>(null)
  const [confirmGroup, setConfirmGroup] = useState<{ group: ReadingGroup; count: number } | null>(null)
  /** The row the selection is on; when that row goes, the one that took its
   *  place (by index). */
  const [cursorId, setCursorId] = useState<string | null>(null)
  const cursorIndexRef = useRef(0)
  const undoRef = useRef<ShelfUndo[]>([])
  useEffect(() => { undoRef.current = [] }, [profileId])

  const pageTab = useAppStore(lastWebTab)

  // ── multi-select (Ctrl/Cmd = toggle, Shift = range) for group creation ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)

  // ── pointer-based drag & drop: reorder readings and groups, move readings
  // between the ungrouped list, groups and the archive ──
  const [drag, setDrag] = useState<ShelfDrag | null>(null)
  const [drop, setDrop] = useState<ShelfDrop | null>(null)
  const dropRef = useRef<ShelfDrop | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const activated = useRef(false)
  const suppressClick = useRef(false)

  // Load this profile's shelf and keep it live via the broadcast.
  useEffect(() => {
    if (!profileId) { setReadings([]); setGroups([]); setLoaded(true); return }
    let active = true
    setLoaded(false)
    window.electronAPI.bookshelfList?.(profileId).then((shelf) => {
      if (!active) return
      setLoaded(true)
      if (!shelf) return
      setReadings((shelf.readings as Reading[]) || [])
      setGroups((shelf.groups as ReadingGroup[]) || [])
    }).catch((err: unknown) => {
      log.warn('bookshelf: loading the shelf failed', { err: String(err) })
      if (active) setLoaded(true)
    })
    const cleanup = window.electronAPI.onBookshelfUpdated?.((payload) => {
      if (payload.profileId !== profileId) return
      setReadings((payload.readings as Reading[]) || [])
      setGroups((payload.groups as ReadingGroup[]) || [])
    })
    return () => { active = false; cleanup?.() }
  }, [profileId])

  /** Show the shelf a reorder hands back right away instead of waiting for the
   *  debounced broadcast, which holding Ctrl+J/K would outrun. */
  const applyShelf = useCallback((shelf: { readings: Reading[]; groups: ReadingGroup[] } | undefined) => {
    if (!shelf) return
    setReadings(shelf.readings || [])
    setGroups(shelf.groups || [])
  }, [])

  const logShelfError = (what: string) => (err: unknown): void => {
    log.warn(`bookshelf: ${what} failed`, { err: String(err) })
  }

  /** A reading in a new tab — in front, or (`background`) behind the shelf. */
  const openReading = useCallback((r: Reading, offline: boolean, background = false) => {
    const s = useAppStore.getState()
    const url = offline && r.offlinePath
      ? `file:///${r.offlinePath.replace(/\\/g, '/')}`
      : r.url
    if (s.activeWorkspaceId) s.addTabNearActive(s.activeWorkspaceId, url, !background)
  }, [])

  const commitRename = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfUpdate?.(profileId, id, { title: editValue })
    setEditingId(null)
    setEditValue('')
  }, [profileId, editValue])

  const setStatus = useCallback((id: string, status: ReadingStatus) => {
    if (profileId) window.electronAPI.bookshelfUpdate?.(profileId, id, { status })
  }, [profileId])

  const remove = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfRemove?.(profileId, id)
  }, [profileId])

  // Readings' copies take over the selection, so a Move right after picks
  // them up rather than the originals — Duplicate + Move is how a reading
  // gets copied to another profile's shelf.
  const duplicate = useCallback(async (ids: string[], selectCopies: boolean) => {
    if (!profileId) return
    const copies = await window.electronAPI.bookshelfDuplicate?.(profileId, ids)
    if (selectCopies && copies?.length) setSelectedIds(new Set(copies))
  }, [profileId])

  const saveOffline = useCallback(async (id: string) => {
    if (!profileId) return
    const partition = useAppStore.getState().getActivePartition() || ''
    setSavingIds((prev) => new Set(prev).add(id))
    try { await window.electronAPI.bookshelfSaveOffline?.(profileId, id, partition) }
    finally { setSavingIds((prev) => { const n = new Set(prev); n.delete(id); return n }) }
  }, [profileId])

  /** + (nb): the page you were on before the shelf, onto it. */
  const addCurrentPage = useCallback(() => {
    if (!profileId) return
    const tab = lastWebTab(useAppStore.getState())
    if (!tab) return
    window.electronAPI.bookshelfAdd?.(profileId, { url: tab.url, title: tab.title, favicon: tab.favicon })
  }, [profileId])

  // ── group ops ──
  // Create a new group, file the given readings into it (if any), and drop
  // straight into rename. Shared by the header button, ng and the menus.
  const groupReadings = useCallback(async (ids: string[]) => {
    if (!profileId) return
    setSelectedIds(new Set())
    const g = await window.electronAPI.bookshelfAddGroup?.(profileId, 'New Group')
    const gid = g && (g as ReadingGroup).id ? (g as ReadingGroup).id : null
    if (!gid) return
    for (const id of ids) window.electronAPI.bookshelfMoveReading?.(profileId, id, gid)
    setEditingGroupId(gid)
    setGroupEditValue((g as ReadingGroup).name)
  }, [profileId])

  const commitGroupRename = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfUpdateGroup?.(profileId, id, { name: groupEditValue })
    setEditingGroupId(null)
    setGroupEditValue('')
  }, [profileId, groupEditValue])

  const toggleGroup = useCallback((g: ReadingGroup) => {
    if (profileId) window.electronAPI.bookshelfUpdateGroup?.(profileId, g.id, { isCollapsed: !g.isCollapsed })
  }, [profileId])

  const ungroup = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfRemoveGroup?.(profileId, id, false)
  }, [profileId])

  const deleteGroup = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfRemoveGroup?.(profileId, id, true)
  }, [profileId])

  // ── The filter: the address bar ──
  const editing = editingId !== null || editingGroupId !== null
  const query = useAddressFilter('bookshelf', {
    label: 'Bookshelf',
    placeholder: 'Filter the Bookshelf…',
    onKey: (e) => barKey(e),
    onEnter: (e) => {
      const row = cursorRowRef.current
      if (!row) return false
      activateRow(row, e.shiftKey ? 'background' : 'front')
      return true
    },
  })
  const q = query.trim()

  /** The shelf as shown: with a filter, only the readings that match — by
   *  title, then address — under their headings, every section unfolded. */
  const view = useMemo<ShelfView>(() => {
    const toRead = (r: Reading): boolean => r.status === 'toread'
    let matches: Set<string> | null = null
    let groupMatches: Set<string> | null = null
    if (q) {
      matches = new Set(fuzzyFilter(q, readings, (r) => [
        { value: r.title, weight: 1 },
        { value: r.url, weight: 0.6 },
      ]).map((r) => r.id))
      groupMatches = new Set(fuzzyFilter(q, groups, (g) => [{ value: g.name, weight: 1 }]).map((g) => g.id))
    }
    const shown = (r: Reading): boolean => !matches || matches.has(r.id)
    const out: ShelfView = {
      ungrouped: readings.filter((r) => toRead(r) && !r.groupId && shown(r)),
      groups: [],
      archived: readings.filter((r) => r.status === 'archived' && shown(r)),
      archiveOpen: q ? true : !archiveCollapsed,
    }
    for (const g of groups) {
      const all = readings.filter((r) => toRead(r) && r.groupId === g.id)
      // A group whose name matches shows all of its readings.
      const items = groupMatches?.has(g.id) ? all : all.filter(shown)
      // The group being renamed stays, filter or not (a new one made while
      // filtering is empty and named New Group): hidden, its name field
      // would never mount to end the rename, and the page's keys would wait
      // on it for good.
      if (q && items.length === 0 && !groupMatches?.has(g.id) && g.id !== editingGroupId) continue
      out.groups.push({ group: g, items, all: all.length, open: q ? true : !g.isCollapsed })
    }
    return out
  }, [q, readings, groups, archiveCollapsed, editingGroupId])

  // The rows the selection goes through, as drawn.
  const rows = useMemo<ShelfRow[]>(() => {
    const out: ShelfRow[] = []
    for (const r of view.ungrouped) out.push({ kind: 'reading', id: r.id, reading: r, container: UNGROUPED })
    for (const { group, items, open } of view.groups) {
      out.push({ kind: 'group', id: group.id, group })
      if (open) for (const r of items) out.push({ kind: 'reading', id: r.id, reading: r, container: group.id })
    }
    if (view.archived.length > 0) {
      out.push({ kind: 'archive', id: ARCHIVE_ROW_ID })
      if (view.archiveOpen) for (const r of view.archived) out.push({ kind: 'reading', id: r.id, reading: r, container: ARCHIVE_ROW_ID })
    }
    return out
  }, [view])

  const foundAt = cursorId ? rows.findIndex((r) => r.id === cursorId) : -1
  const cursorAt = rows.length === 0 ? -1 : foundAt !== -1 ? foundAt : Math.min(cursorIndexRef.current, rows.length - 1)
  cursorIndexRef.current = Math.max(cursorAt, 0)
  const cursorRow = cursorAt === -1 ? null : rows[cursorAt]
  const cursorRowRef = useRef(cursorRow)
  cursorRowRef.current = cursorRow

  // A new filter: the selection on its best match — the first reading shown.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => {
    const first = rowsRef.current.find((r) => r.kind === 'reading') ?? rowsRef.current[0]
    setCursorId(first?.id ?? null)
  }, [q])

  const findRowEl = (id: string): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-shelf-row="${CSS.escape(id)}"]`) ?? null
  // The keyboard moving the selection brings its row into sight; the mouse
  // resting on a row doesn't scroll the list under it.
  const hoveredRef = useRef(false)
  const hoverRow = (id: string): void => {
    if (drag || cursorId === id) return
    hoveredRef.current = true
    setCursorId(id)
  }
  useEffect(() => {
    if (hoveredRef.current) {
      hoveredRef.current = false
      return
    }
    if (cursorRow) findRowEl(cursorRow.id)?.scrollIntoView({ block: 'nearest' })
    // findRowEl reads the DOM as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorRow?.id, rows])

  // ── right-click and keyboard menus (the sidebar's dropdown popup) ──
  /** Opened from the keyboard (m), a menu takes it — its first action
   *  highlighted, a key on each — and gives it back to the window after. */
  const showMenu = async (spec: Parameters<typeof openDropdownAsync>[0], keyboard: boolean) => {
    const result = await openDropdownAsync(keyboard ? { ...spec, keyboard: true } : spec)
    if (keyboard) reclaimRendererFocus()
    return result
  }

  const openGroupMenu = async (g: ReadingGroup, at: MenuPoint, keyboard = false): Promise<void> => {
    if (!profileId) return
    const count = readings.filter((r) => r.status === 'toread' && r.groupId === g.id).length
    const actions: DropdownAction[] = [
      { id: 'rename', label: 'Rename Group', iconName: 'Pencil', key: 'r' },
      { id: 'collapse', label: g.isCollapsed ? 'Expand Group' : 'Collapse Group', iconName: 'Folder', key: 'c' },
      { id: 'move-group', label: 'Move Group…', iconName: 'FolderInput', divider: 'before', key: 'm' },
      { id: 'duplicate-group', label: 'Duplicate Group', iconName: 'CopyPlus', key: 'd' },
      { id: 'ungroup', label: 'Ungroup (keep readings)', iconName: 'FolderMinus', divider: 'before', key: 'u' },
      {
        id: 'delete',
        label: `Delete Group (${count} ${count === 1 ? 'reading' : 'readings'})`,
        iconName: 'Trash2',
        destructive: true,
        key: 'x',
      },
    ]
    const result = await showMenu({
      kind: 'menu',
      position: at,
      ...readThemeAttrs(),
      header: g.name,
      actions,
    }, keyboard)
    if (!result || result.type !== 'action') return
    if (result.actionId === 'rename') { setEditingGroupId(g.id); setGroupEditValue(g.name) }
    else if (result.actionId === 'collapse') toggleGroup(g)
    else if (result.actionId === 'move-group') setMoveTarget({ kind: 'group', id: g.id })
    // The copy lands right below the original and nothing else changes.
    else if (result.actionId === 'duplicate-group') void duplicate([g.id], false)
    else if (result.actionId === 'ungroup') ungroup(g.id)
    else if (result.actionId === 'delete') deleteGroup(g.id)
  }

  const openReadingMenu = async (r: Reading, at: MenuPoint, keyboard = false): Promise<void> => {
    if (!profileId) return
    // Right-clicking one of the multi-selected readings acts on the whole
    // selection (same as the sidebar's tab context menu).
    const useSelection = selectedIds.has(r.id) && selectedIds.size > 1
    const targets = useSelection ? [...selectedIds] : [r.id]
    const hasOffline = !!r.offlinePath
    const actions: DropdownAction[] = []
    if (!useSelection) {
      actions.push({ id: 'open', label: 'Open', iconName: 'Globe', key: 'o' })
      if (hasOffline) actions.push({ id: 'open-offline', label: 'Open Offline Copy', iconName: 'Download', key: 'O' })
      actions.push({ id: 'rename', label: 'Rename', iconName: 'Pencil', divider: 'before', key: 'r' })
      actions.push({ id: 'save-offline', label: hasOffline ? 'Re-save Offline' : 'Save for Offline', iconName: 'Download', key: 's' })
    }
    actions.push({
      id: 'duplicate',
      label: useSelection ? `Duplicate ${targets.length} Readings` : 'Duplicate',
      iconName: 'CopyPlus',
      key: 'd',
    })
    actions.push({
      id: 'new-group',
      label: useSelection ? `Add ${targets.length} Readings to New Group` : 'Add to New Group',
      iconName: 'FolderPlus',
      divider: 'before',
      key: 'n',
    })
    if (!useSelection && r.groupId) actions.push({ id: 'ungroup-reading', label: 'Remove from Group', iconName: 'FolderMinus', key: 'u' })
    actions.push({
      id: 'move',
      label: useSelection ? `Move ${targets.length} Readings…` : 'Move…',
      iconName: 'FolderInput',
      key: 'm',
    })
    if (!useSelection) {
      if (r.status === 'archived') actions.push({ id: 'unarchive', label: 'Move to To Read', iconName: 'FolderInput', divider: 'before', key: 't' })
      else actions.push({ id: 'archive', label: 'Archive', iconName: 'EyeOff', divider: 'before', key: 'a' })
    }
    actions.push({
      id: 'remove',
      label: useSelection ? `Remove ${targets.length} Readings` : 'Remove',
      iconName: 'Trash2',
      destructive: true,
      divider: useSelection ? 'before' : undefined,
      key: 'x',
    })

    const result = await showMenu({
      kind: 'menu',
      position: at,
      ...readThemeAttrs(),
      header: useSelection ? `${targets.length} readings` : r.title,
      actions,
    }, keyboard)
    if (!result || result.type !== 'action') return
    switch (result.actionId) {
      case 'open': openReading(r, false); break
      case 'open-offline': openReading(r, true); break
      case 'rename': setEditingId(r.id); setEditValue(r.title); break
      case 'save-offline': void saveOffline(r.id); break
      case 'duplicate': void duplicate(targets, true); break
      case 'new-group': void groupReadings(targets); break
      case 'move': setMoveTarget({ kind: 'readings', ids: targets }); break
      case 'ungroup-reading': window.electronAPI.bookshelfMoveReading?.(profileId, r.id, null); break
      case 'archive': setStatus(r.id, 'archived'); break
      case 'unarchive': setStatus(r.id, 'toread'); break
      case 'remove':
        for (const id of targets) remove(id)
        setSelectedIds(new Set())
        break
    }
  }

  // ── drag & drop ──
  /** A container's readings in display order (the whole shelf's, filter or
   *  no filter: where a reading lands is among all of them). */
  const containerReadings = useCallback((key: string): Reading[] => {
    if (key === UNGROUPED) return readings.filter((r) => r.status === 'toread' && !r.groupId)
    if (key === ARCHIVE_ROW_ID) return readings.filter((r) => r.status === 'archived')
    return readings.filter((r) => r.status === 'toread' && r.groupId === key)
  }, [readings])

  /** Reading ids in display order, so Shift range-select matches the eye. */
  const orderedIds = (): string[] => rows.filter((r) => r.kind === 'reading').map((r) => r.id)

  // Hit-test the pointer against the rendered rows the sidebar's way: the
  // nearest row edge wins, and a header or empty placeholder under the
  // pointer takes the drop into its container.
  const computeDrop = useCallback((y: number, d: ShelfDrag): void => {
    const root = listRef.current
    if (!root) return
    let best: ShelfDrop | null = null
    let bestDist = Infinity
    const settle = (): void => { dropRef.current = best; setDrop(best) }
    if (d.type === 'group') {
      root.querySelectorAll<HTMLElement>('[data-drop-group-block]').forEach((el) => {
        const i = groups.findIndex((g) => g.id === el.dataset.dropGroupBlock)
        if (i === -1) return
        const rect = el.getBoundingClientRect()
        const mid = rect.top + rect.height / 2
        const dist = Math.abs(y - mid)
        if (dist >= bestDist) return
        bestDist = dist
        let at = y < mid ? i : i + 1
        // Right before itself is its own spot — anchor on what follows.
        if (groups[at]?.id === d.id) at++
        best = { type: 'group', beforeId: groups[at]?.id ?? null }
      })
      settle()
      return
    }
    const dragged = new Set(d.ids)
    // The first reading from `index` on that isn't itself being dragged.
    const anchorFrom = (container: string, index: number): string | null =>
      containerReadings(container).slice(index).find((r) => !dragged.has(r.id))?.id ?? null
    root.querySelectorAll<HTMLElement>('[data-drop-reading], [data-drop-into]').forEach((el) => {
      const rect = el.getBoundingClientRect()
      const into = el.dataset.dropInto
      if (into !== undefined) {
        if (y < rect.top || y > rect.bottom) return
        bestDist = 0
        best = { type: 'reading', container: into, beforeId: anchorFrom(into, 0), into: true }
        return
      }
      const container = el.dataset.dropContainer ?? UNGROUPED
      const index = containerReadings(container).findIndex((r) => r.id === el.dataset.dropReading)
      if (index === -1) return
      const above = y < rect.top + rect.height / 2
      const dist = Math.abs(y - (above ? rect.top : rect.bottom))
      if (dist >= bestDist) return
      bestDist = dist
      best = { type: 'reading', container, beforeId: anchorFrom(container, above ? index : index + 1), into: false }
    })
    settle()
  }, [groups, containerReadings])

  // Read by the window listeners a drag installs, which outlive the render
  // that started it.
  const computeDropRef = useRef(computeDrop)
  computeDropRef.current = computeDrop

  const finish = useCallback((d: ShelfDrag) => {
    // The ref, not state: the last move's target may not have rendered yet.
    const dt = dropRef.current
    dropRef.current = null
    setDrag(null)
    setDrop(null)
    if (!dt || !profileId) return
    if (d.type === 'reading' && dt.type === 'reading') {
      window.electronAPI.bookshelfPlaceReadings?.(profileId, d.ids, placeTarget(dt.container), dt.beforeId).then(applyShelf)
      setSelectedIds(new Set())
    } else if (d.type === 'group' && dt.type === 'group') {
      window.electronAPI.bookshelfPlaceGroup?.(profileId, d.id, dt.beforeId).then(applyShelf)
    }
  }, [profileId, applyShelf])
  const finishRef = useRef(finish)
  finishRef.current = finish

  // A drag in flight when the page goes (tb, another tab) mustn't leave its
  // listeners behind.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanupRef.current?.(), [])

  const startDrag = useCallback((item: ShelfDrag, e: React.MouseEvent) => {
    // Modifier-clicks are multi-select, not drags — let them through to onClick.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    startPos.current = { x: e.clientX, y: e.clientY }
    activated.current = false
    const onMove = (me: MouseEvent): void => {
      if (!startPos.current) return
      const moved = Math.abs(me.clientX - startPos.current.x) + Math.abs(me.clientY - startPos.current.y)
      if (!activated.current && moved < 6) return
      if (!activated.current) {
        activated.current = true
        suppressClick.current = true
        setDrag(item)
      }
      computeDropRef.current(me.clientY, item)
    }
    const cleanup = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragCleanupRef.current = null
    }
    const onUp = (): void => {
      cleanup()
      if (activated.current) finishRef.current(item)
      startPos.current = null
      activated.current = false
      // Let the row's click fire first and be swallowed, then re-enable.
      setTimeout(() => { suppressClick.current = false }, 0)
    }
    dragCleanupRef.current?.()
    dragCleanupRef.current = cleanup
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const handleReadingClick = (r: Reading, e: React.MouseEvent): void => {
    if (suppressClick.current) return // a drag just ended — don't treat as a click
    setCursorId(r.id)
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(r.id)) next.delete(r.id)
        else next.add(r.id)
        return next
      })
      lastClickedRef.current = r.id
      return
    }
    if (e.shiftKey && lastClickedRef.current) {
      const ord = orderedIds()
      const a = ord.indexOf(lastClickedRef.current)
      const b = ord.indexOf(r.id)
      if (a !== -1 && b !== -1) setSelectedIds(new Set(ord.slice(Math.min(a, b), Math.max(a, b) + 1)))
      return
    }
    setSelectedIds(new Set())
    lastClickedRef.current = r.id
    openReading(r, false)
  }

  // ── The keys ──

  const moveCursorTo = (index: number): void => {
    if (rows.length === 0) return
    setCursorId(rows[Math.max(0, Math.min(rows.length - 1, index))].id)
  }
  const halfPage = (): number => {
    const scroller = scrollRef.current
    const row = listRef.current?.querySelector<HTMLElement>('[data-shelf-row]')
    if (!scroller || !row || row.offsetHeight === 0) return 8
    return Math.max(1, Math.floor(scroller.clientHeight / row.offsetHeight / 2))
  }
  /** Before a row goes (a group with its readings): the selection onto the
   *  one after it, or before. */
  const stepOffRow = (id: string): void => {
    const at = rows.findIndex((r) => r.id === id)
    if (at === -1) return
    const stays = (r: ShelfRow): boolean => r.id !== id && !(r.kind === 'reading' && r.container === id)
    const next = rows.slice(at + 1).find(stays) ?? rows.slice(0, at).reverse().find(stays)
    setCursorId(next?.id ?? null)
  }
  const groupOf = (row: ShelfRow | null): ReadingGroup | null => {
    if (!row) return null
    if (row.kind === 'group') return row.group
    if (row.kind === 'reading') return groups.find((g) => g.id === row.container) ?? null
    return null
  }

  /** Enter, a label or the filter's Enter on a row: a reading opens in a
   *  new tab (`background`: behind the shelf), a header folds or unfolds. */
  function activateRow(row: ShelfRow, how: 'front' | 'background'): void {
    setCursorId(row.id)
    if (row.kind === 'group') {
      if (!q) toggleGroup(row.group)
    } else if (row.kind === 'archive') {
      if (!q) setArchiveCollapsed((v) => !v)
    } else openReading(row.reading, false, how === 'background')
  }

  /** dd and dg on a group: gone with its readings, once you say so — at
   *  once when it has none. */
  const askDeleteGroup = (g: ReadingGroup): void => {
    const count = readings.filter((r) => r.status === 'toread' && r.groupId === g.id).length
    if (count === 0) {
      stepOffRow(g.id)
      deleteGroup(g.id)
      return
    }
    setConfirmGroup({ group: g, count })
  }

  /** dd: a reading to read is done — archived; an archived one removed; a
   *  group deleted. u brings the readings back. */
  const deleteRow = (row: ShelfRow): boolean => {
    if (!profileId) return false
    if (row.kind === 'group') {
      askDeleteGroup(row.group)
      return true
    }
    if (row.kind !== 'reading') return false
    const list = containerReadings(row.container)
    const beforeId = list[list.findIndex((r) => r.id === row.id) + 1]?.id ?? null
    stepOffRow(row.id)
    if (row.reading.status === 'archived') {
      undoRef.current.push({ kind: 'removed', reading: row.reading, beforeId })
      remove(row.id)
    } else {
      undoRef.current.push({ kind: 'archived', id: row.id, groupId: row.container === UNGROUPED ? null : row.container, beforeId })
      setStatus(row.id, 'archived')
    }
    return true
  }

  /** u: the last dd undone, the reading back where it was. False with
   *  nothing to undo: u then reopens a closed tab, as anywhere. */
  const undo = (): boolean => {
    const last = undoRef.current.pop()
    if (!last || !profileId) return false
    const api = window.electronAPI
    if (last.kind === 'archived') {
      setCursorId(last.id)
      api.bookshelfPlaceReadings?.(profileId, [last.id], { groupId: last.groupId }, last.beforeId)
        .then(applyShelf)
        .catch(logShelfError('undoing the archive'))
      return true
    }
    // Removed for good: put back in the Archive as it was, by its own id —
    // not added again by its address, which another reading of the same
    // page would answer to. Its offline copy went with it.
    const { reading, beforeId } = last
    setCursorId(reading.id)
    api.bookshelfRestore?.(profileId, reading, beforeId)
      .then(applyShelf)
      .catch(logShelfError('undoing the removal'))
    return true
  }

  /** h / l: a header folds or unfolds; on a reading in a group, h folds it
   *  and goes to its header, l on an unfolded header steps in. With a
   *  filter everything shows unfolded: they only move. */
  const foldRow = (unfold: boolean): void => {
    const row = cursorRow
    if (!row) return
    if (row.kind === 'group') {
      if (!q && row.group.isCollapsed === unfold) toggleGroup(row.group)
      else if (unfold) moveCursorTo(cursorAt + 1)
      return
    }
    if (row.kind === 'archive') {
      if (!q && archiveCollapsed === unfold) setArchiveCollapsed(!unfold)
      else if (unfold) moveCursorTo(cursorAt + 1)
      return
    }
    if (unfold) return
    if (row.container === ARCHIVE_ROW_ID) {
      if (!q) setArchiveCollapsed(true)
      setCursorId(ARCHIVE_ROW_ID)
      return
    }
    const group = groupOf(row)
    if (!group) return
    if (!q && !group.isCollapsed) toggleGroup(group)
    setCursorId(group.id)
  }

  /** <C-j> / <C-k>: the row one down or up. A reading moves within its
   *  list, and on from either end of a To Read list into the next one; a
   *  group swaps with its neighbour. */
  const moveRow = (dir: 1 | -1): void => {
    const row = cursorRow
    if (!row || !profileId) return
    const api = window.electronAPI
    if (row.kind === 'group') {
      const at = groups.findIndex((g) => g.id === row.id)
      if (at === -1 || (dir === 1 && at === groups.length - 1) || (dir === -1 && at === 0)) return
      const beforeId = dir === 1 ? groups[at + 2]?.id ?? null : groups[at - 1].id
      api.bookshelfPlaceGroup?.(profileId, row.id, beforeId).then(applyShelf).catch(logShelfError('moving the group'))
      return
    }
    if (row.kind !== 'reading') return
    const list = containerReadings(row.container)
    const at = list.findIndex((r) => r.id === row.id)
    let container = row.container
    let beforeId: string | null
    if (dir === 1 && at < list.length - 1) beforeId = list[at + 2]?.id ?? null
    else if (dir === -1 && at > 0) beforeId = list[at - 1].id
    else {
      // Off the end: on into the next To Read list (the archive keeps its own).
      if (row.container === ARCHIVE_ROW_ID) return
      const order = [UNGROUPED, ...groups.map((g) => g.id)]
      const next = order[order.indexOf(row.container) + dir]
      if (!next) return
      container = next
      beforeId = dir === 1 ? containerReadings(next)[0]?.id ?? null : null
      // A group it goes into unfolds, so it stays in sight.
      const into = groups.find((g) => g.id === next)
      if (into?.isCollapsed) toggleGroup(into)
    }
    api.bookshelfPlaceReadings?.(profileId, [row.id], placeTarget(container), beforeId)
      .then(applyShelf)
      .catch(logShelfError('moving the reading'))
  }

  /** m: the selected row's menu, keyboard and all. */
  const openRowMenu = (): void => {
    const row = cursorRow
    if (!row || row.kind === 'archive') return
    const rect = findRowEl(row.id)?.getBoundingClientRect()
    const at = rect ? { x: rect.left + 32, y: rect.bottom } : { x: window.innerWidth / 2, y: 120 }
    const failed = logShelfError('the row menu')
    if (row.kind === 'group') openGroupMenu(row.group, at, true).catch(failed)
    else openReadingMenu(row.reading, at, true).catch(failed)
  }

  /** ng: a new group — of the selected reading, if it's one to read —
   *  named at once. */
  const newGroup = (): void => {
    const row = cursorRow
    const ids = row?.kind === 'reading' && row.reading.status === 'toread' ? [row.id] : []
    groupReadings(ids)
      .then(() => { if (ids[0]) setCursorId(ids[0]) })
      .catch(logShelfError('making a group'))
  }

  /** A dialog over the page (Move, the group's deletion) or a rename keeps
   *  its keys. */
  const busy = editing || moveTarget !== null || confirmGroup !== null

  /** Keys ahead of the keymap in COMMAND: Enter opens, Esc drops a
   *  multi-selection. */
  const pageIntercept = (e: KeyboardEvent): boolean => {
    if (busy || e.ctrlKey || e.metaKey || e.altKey) return false
    if (keyTokenFromEvent(e) === '<CR>') {
      if (!cursorRow) return false
      activateRow(cursorRow, e.shiftKey ? 'background' : 'front')
      return true
    }
    if (e.key === 'Escape' && selectedIds.size > 0) {
      setSelectedIds(new Set())
      return true
    }
    return false
  }

  const pageCommand = (command: string): boolean => {
    if (busy) return false
    switch (command) {
      case 'scroll-down': moveCursorTo(cursorAt + 1); return true
      case 'scroll-up': moveCursorTo(cursorAt - 1); return true
      case 'half-page-down': moveCursorTo(cursorAt + halfPage()); return true
      case 'half-page-up': moveCursorTo(cursorAt - halfPage()); return true
      case 'page-top': moveCursorTo(0); return true
      case 'page-bottom': moveCursorTo(rows.length - 1); return true
      case 'back': foldRow(false); return true
      case 'forward': foldRow(true); return true
      case 'row-move-down': moveRow(1); return true
      case 'row-move-up': moveRow(-1); return true
      case 'row-menu': openRowMenu(); return true
      case 'insert-mode':
      case 'focus-input':
        return focusAddressFilter()
      // The shelf's own: on a row they act on it rather than on the tab.
      // dd on a row is the shelf's even where it does nothing (the Archive
      // header): passed on, it would close the Bookshelf's own tab.
      case 'close-tab':
        if (!cursorRow) return false
        deleteRow(cursorRow)
        return true
      case 'close-group': {
        const group = groupOf(cursorRow)
        if (!group) return false
        askDeleteGroup(group)
        return true
      }
      case 'reopen-closed-tab': return undo()
      case 'new-group': newGroup(); return true
      case 'add-to-bookshelf': addCurrentPage(); return true
      case 'copy-url':
        // The reading's address, not the page's — and on a header nothing,
        // rather than the shelf's own vimperium://bookshelf over the
        // clipboard.
        if (!cursorRow) return false
        if (cursorRow.kind === 'reading') window.electronAPI.clipboardWriteText(cursorRow.reading.url)
        return true
    }
    return false
  }
  usePageKeys({ intercept: pageIntercept, command: pageCommand })

  /** ↑ ↓ PageUp PageDown Tab typed in the filter. */
  function barKey(e: AddressFilterKeyEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    switch (e.key) {
      case 'ArrowDown': moveCursorTo(cursorAt + 1); return true
      case 'ArrowUp': moveCursorTo(cursorAt - 1); return true
      case 'PageDown': moveCursorTo(cursorAt + halfPage()); return true
      case 'PageUp': moveCursorTo(cursorAt - halfPage()); return true
      case 'Tab': moveCursorTo(cursorAt + (e.shiftKey ? -1 : 1)); return true
    }
    return false
  }

  // Without Vim mode: arrows and Enter, outside a field. (In Vim's COMMAND
  // the keys come through usePageKeys instead and never get this far.)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    if (vimMode || e.defaultPrevented || busy) return
    const target = e.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a'))) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    let handled = true
    if (e.key === 'ArrowDown') moveCursorTo(cursorAt + 1)
    else if (e.key === 'ArrowUp') moveCursorTo(cursorAt - 1)
    else if (e.key === 'Enter' && cursorRow) activateRow(cursorRow, e.shiftKey ? 'background' : 'front')
    else handled = false
    if (handled) e.preventDefault()
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // COMMAND's labels on the rows (lib/hint-labels.ts): typing one does what
  // Enter on it would.
  useHintTargets('bookshelf-page', 0, vimMode === 'command' && hintsOn && !busy
    ? rows.map((row) => ({
      id: hintId(row),
      name: row.kind === 'reading' ? row.reading.title : row.kind === 'group' ? row.group.name : 'Archive',
      activate: () => {
        const current = rowsRef.current.find((r) => r.id === row.id)
        if (current) activateRow(current, 'front')
      },
    }))
    : null)
  const hintLabels = useHintLabels()

  /** A row's label, as a keycap before its icon. */
  const rowHint = (row: ShelfRow): React.ReactNode => {
    const label = hintsOn && !busy ? hintLabels.get(hintId(row)) : undefined
    return label ? <RowHint mode={vimMode} label={label} pending={vimPending} className="shrink-0" /> : null
  }

  // ── Render ──

  const keyOf = (command: string): string | undefined => vimKeyCaps(vimKeymap, command)[0]
  const titleWithKey = (title: string, key: string | undefined): string => (key ? `${title} (${key})` : title)

  const toReadCount = readings.filter((r) => r.status === 'toread').length
  const archivedCount = readings.filter((r) => r.status === 'archived').length
  const isEmpty = readings.length === 0 && groups.length === 0
  const nothingMatches = !!q && rows.length === 0

  const isDropInto = (container: string): boolean =>
    drop?.type === 'reading' && drop.into && drop.container === container
  const isDropAtEnd = (container: string): boolean =>
    drop?.type === 'reading' && !drop.into && drop.container === container && drop.beforeId === null

  const cursorClass = 'bg-accent text-accent-foreground'

  const renderRow = (r: Reading, container: string) => {
    const row: ShelfRow = { kind: 'reading', id: r.id, reading: r, container }
    const isArchived = container === ARCHIVE_ROW_ID
    if (editingId === r.id) {
      return (
        <div key={r.id} data-shelf-row={r.id} className="relative flex items-center gap-2 rounded-lg py-2 pl-3 pr-4">
          <span className="flex w-5 shrink-0 items-center"><TabFavicon favicon={r.favicon} /></span>
          <InlineRenameInput
            value={editValue}
            onChange={setEditValue}
            onCommit={() => commitRename(r.id)}
            onCancel={() => { setEditingId(null); setEditValue('') }}
            className="flex-1 min-w-0 field rounded-md px-2 py-1 text-sm text-foreground outline-none"
          />
        </div>
      )
    }
    const saving = savingIds.has(r.id)
    const hasOffline = !!r.offlinePath
    const selected = selectedIds.has(r.id)
    const isCursor = cursorRow?.id === r.id
    const dragged = drag?.type === 'reading' && drag.ids.includes(r.id)
    return (
      <div
        key={r.id}
        data-shelf-row={r.id}
        // Vim's ; (chrome-hints) labels it: typing the label clicks the row.
        data-chrome-hint=""
        data-drop-reading={r.id}
        data-drop-container={container}
        role="option"
        aria-selected={isCursor}
        className={`relative flex cursor-pointer items-center gap-2 rounded-lg py-2 pl-3 pr-4 group/row ${
          isCursor ? cursorClass : selected ? 'bg-primary/20 text-foreground' : 'hover:bg-accent/50'
        } ${dragged ? 'opacity-30' : isArchived && !isCursor ? 'opacity-60' : ''}`}
        title={r.url}
        onMouseDown={(e) => {
          // A selected row carries the whole selection, in display order.
          const ids = selected && selectedIds.size > 1
            ? orderedIds().filter((id) => selectedIds.has(id))
            : [r.id]
          startDrag({ type: 'reading', ids }, e)
        }}
        onMouseMove={() => hoverRow(r.id)}
        onClick={(e) => handleReadingClick(r, e)}
        onContextMenu={(e) => { setCursorId(r.id); void openReadingMenu(r, contextMenuPoint(e)) }}
      >
        {drop?.type === 'reading' && !drop.into && drop.beforeId === r.id && <DropLine />}
        {rowHint(row)}
        <span className="flex w-5 shrink-0 items-center"><TabFavicon favicon={r.favicon} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm">{r.title || r.url}</span>
            {hasOffline && <WifiOff size={11} className="shrink-0 text-muted-foreground" aria-label="Saved offline" />}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">{r.url}</div>
        </div>
        {/* Action overlay floated at the right edge so it never changes the
            row height — same pattern as the sidebar's close button. */}
        <div className="absolute right-2 top-0 bottom-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity pointer-events-none group-hover/row:pointer-events-auto">
          <RowBtn label="Rename" onClick={() => { setEditingId(r.id); setEditValue(r.title) }}>
            <Pencil size={13} />
          </RowBtn>
          {saving ? (
            <span className="flex h-7 w-7 items-center justify-center rounded bg-card/85 backdrop-blur-sm text-muted-foreground">
              <Loader2 size={13} className="animate-spin" />
            </span>
          ) : (
            <RowBtn
              label={hasOffline ? 'Open offline copy' : 'Save for offline'}
              onClick={() => { if (hasOffline) openReading(r, true); else void saveOffline(r.id) }}
              active={hasOffline}
            >
              {hasOffline ? <WifiOff size={13} /> : <Download size={13} />}
            </RowBtn>
          )}
          {isArchived ? (
            <RowBtn label="Move to To Read" onClick={() => setStatus(r.id, 'toread')}>
              <ArchiveRestore size={13} />
            </RowBtn>
          ) : (
            <RowBtn label="Archive" onClick={() => setStatus(r.id, 'archived')}>
              <Archive size={13} />
            </RowBtn>
          )}
          <RowBtn label="Remove" onClick={() => remove(r.id)} danger>
            <Trash2 size={13} />
          </RowBtn>
        </div>
      </div>
    )
  }

  const renderGroup = ({ group: g, items, all, open }: ShelfView['groups'][number]) => {
    const row: ShelfRow = { kind: 'group', id: g.id, group: g }
    const isCursor = cursorRow?.id === g.id
    return (
      <div
        key={g.id}
        data-group-container=""
        data-drop-group-block={g.id}
        className={`relative mt-3 ${drag?.type === 'group' && drag.id === g.id ? 'opacity-30' : ''}`}
        style={{ ['--gc' as string]: g.color }}
      >
        {drop?.type === 'group' && drop.beforeId === g.id && <DropLine />}
        {/* The Sidebar's tab group: a coloured count badge, its label, then
            the coloured pill with the fold chevron and the name. Colours
            come from globals.css via --gc. */}
        <div
          data-shelf-row={g.id}
          // Vim's ; (chrome-hints) labels it: typing the label clicks the row.
          data-chrome-hint=""
          data-drop-into={g.id}
          role="option"
          aria-selected={isCursor}
          aria-expanded={open}
          className={`group/gh relative flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pl-3 pr-4 ${
            isDropInto(g.id) ? 'bg-primary/30 ring-1 ring-inset ring-primary/40' : isCursor ? cursorClass : 'hover:bg-accent/50'
          }`}
          onMouseDown={(e) => { if (editingGroupId !== g.id) startDrag({ type: 'group', id: g.id }, e) }}
          onMouseMove={() => hoverRow(g.id)}
          onClick={() => {
            if (suppressClick.current || editingGroupId === g.id) return
            setCursorId(g.id)
            if (!q) toggleGroup(g)
          }}
          onContextMenu={(e) => { setCursorId(g.id); void openGroupMenu(g, contextMenuPoint(e)) }}
        >
          <span
            data-group-badge=""
            className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-[11px] font-semibold tabular-nums leading-none"
            title={`${all} ${all === 1 ? 'reading' : 'readings'}`}
          >
            {all}
          </span>
          {/* Its label between the count and the name, as the Sidebar's. */}
          {rowHint(row)}
          <span
            data-group-pill=""
            className="inline-flex items-center gap-1 min-w-0 max-w-full pl-1.5 pr-3 py-1 rounded-md text-sm font-medium overflow-hidden"
          >
            <span className="shrink-0 inline-flex items-center">
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            {editingGroupId === g.id ? (
              <InlineRenameInput
                value={groupEditValue}
                onChange={setGroupEditValue}
                onCommit={() => commitGroupRename(g.id)}
                onCancel={() => { setEditingGroupId(null); setGroupEditValue('') }}
                className="flex-1 min-w-0 bg-transparent outline-none text-inherit placeholder:opacity-60"
              />
            ) : (
              <span className="flex-1 min-w-0 truncate">{g.name}</span>
            )}
          </span>
          {/* Action overlay; card-tone backdrop keeps icons legible. */}
          <div className="absolute right-2 top-0 bottom-0 flex items-center gap-1 opacity-0 group-hover/gh:opacity-100 transition-opacity pointer-events-none group-hover/gh:pointer-events-auto">
            <RowBtn label="Rename group" onClick={() => { setEditingGroupId(g.id); setGroupEditValue(g.name) }}>
              <Pencil size={13} />
            </RowBtn>
            <RowBtn label="Ungroup (keep readings)" onClick={() => ungroup(g.id)}>
              <FolderMinus size={13} />
            </RowBtn>
            <RowBtn label="Delete group & its readings" danger onClick={() => askDeleteGroup(g)}>
              <Trash2 size={13} />
            </RowBtn>
          </div>
        </div>
        {open && (
          <div className="ml-4 mt-0.5 border-l border-border/60 pl-2">
            {items.length === 0 ? (
              <div data-drop-into={g.id} className="px-3 py-2 text-xs text-muted-foreground/60">Drop readings here</div>
            ) : (
              items.map((r) => renderRow(r, g.id))
            )}
            {isDropAtEnd(g.id) && items.length > 0 && <EndDropLine />}
          </div>
        )}
      </div>
    )
  }

  const archiveRow: ShelfRow = { kind: 'archive', id: ARCHIVE_ROW_ID }
  const archiveIsCursor = cursorRow?.id === ARCHIVE_ROW_ID
  const addKey = keyOf('add-to-bookshelf')
  const groupKey = keyOf('new-group')
  const closeKey = keyOf('toggle-bookshelf')

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-background text-foreground select-none"
      role="region"
      aria-label="Bookshelf"
    >
      {/* Header: title, counts and the shelf's actions. */}
      <div className="shrink-0 border-b border-border">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-6 py-4">
          <BookOpen size={18} className="shrink-0 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">Bookshelf</h1>
          {!isEmpty && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {toReadCount} to read{archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={addCurrentPage}
              disabled={!pageTab}
              className="flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title={pageTab
                ? titleWithKey(`Add “${pageTab.title || pageTab.url}” to the Bookshelf`, addKey)
                : 'No page to add: open one first'}
            >
              <Plus size={14} />
              Add page
              {addKey && <KeyCap>{addKey}</KeyCap>}
            </button>
            <button
              onClick={() => { void groupReadings([...selectedIds]) }}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title={titleWithKey(selectedIds.size > 0 ? `New group from ${selectedIds.size} selected` : 'New group', groupKey)}
            >
              <FolderPlus size={14} />
              New group
              {groupKey && <KeyCap>{groupKey}</KeyCap>}
            </button>
            <button
              aria-label="Close the Bookshelf"
              onClick={() => closePage('bookshelf')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
              title={titleWithKey('Close the Bookshelf', closeKey)}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* The shelf: the same padding above and below, scrolled or not. */}
      <div ref={scrollRef} data-vim-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <div
          ref={listRef}
          className="mx-auto max-w-2xl px-4 py-4"
          role="listbox"
          aria-label="Readings"
        >
          {loaded && isEmpty && (
            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
              <BookOpen size={30} className="mb-3 opacity-50" />
              <p className="text-sm font-medium text-foreground">Nothing on the shelf yet</p>
              <p className="mt-1 max-w-sm text-xs">
                {addKey ? <>Press <KeyCap>{addKey}</KeyCap> or </> : null}
                “Add page” to keep the page you were on for later.
                Ctrl/Shift-click readings, then “New group” to group them.
              </p>
            </div>
          )}
          {nothingMatches && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No readings match “{q}”.
            </p>
          )}

          {!isEmpty && !nothingMatches && (
            <>
              {(!q || view.ungrouped.length > 0) && (
                <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>To Read{view.ungrouped.length > 0 ? ` · ${view.ungrouped.length}` : ''}</span>
                  {selectedIds.size > 0 && (
                    <span className="normal-case text-primary">{selectedIds.size} selected · ⇧/⌃-click</span>
                  )}
                </div>
              )}

              <div
                // Once it's empty, the whole strip takes a drop back into To Read.
                {...(view.ungrouped.length === 0 && !q ? { 'data-drop-into': UNGROUPED } : {})}
                className={`rounded-lg transition-colors ${isDropInto(UNGROUPED) ? 'ring-1 ring-inset ring-primary/50 bg-primary/5' : ''}`}
              >
                {view.ungrouped.length === 0 && !q && (
                  <div className="px-3 py-2 text-xs text-muted-foreground/60">
                    {drag?.type === 'reading' ? 'Drop here to take it out of its group' : 'Every reading is in a group'}
                  </div>
                )}
                {view.ungrouped.map((r) => renderRow(r, UNGROUPED))}
                {isDropAtEnd(UNGROUPED) && view.ungrouped.length > 0 && <EndDropLine />}
              </div>

              {view.groups.map(renderGroup)}
              {drop?.type === 'group' && drop.beforeId === null && view.groups.length > 0 && <EndDropLine />}

              {view.archived.length > 0 && (
                <div className="mt-5">
                  <div
                    data-drop-into={ARCHIVE_ROW_ID}
                    data-shelf-row={ARCHIVE_ROW_ID}
                    data-chrome-hint=""
                    role="option"
                    aria-selected={archiveIsCursor}
                    aria-expanded={view.archiveOpen}
                    onMouseMove={() => hoverRow(ARCHIVE_ROW_ID)}
                    onClick={() => { setCursorId(ARCHIVE_ROW_ID); if (!q) setArchiveCollapsed((v) => !v) }}
                    className={`relative flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider ${
                      isDropInto(ARCHIVE_ROW_ID)
                        ? 'bg-primary/30 ring-1 ring-inset ring-primary/40 text-foreground'
                        : archiveIsCursor ? cursorClass : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    }`}
                  >
                    {rowHint(archiveRow)}
                    {view.archiveOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    Archive · {view.archived.length}
                  </div>
                  {view.archiveOpen && view.archived.map((r) => renderRow(r, ARCHIVE_ROW_ID))}
                  {view.archiveOpen && isDropAtEnd(ARCHIVE_ROW_ID) && <EndDropLine />}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <MoveBookshelfDialog
        open={moveTarget !== null}
        target={moveTarget}
        profileId={profileId}
        onMoved={() => setSelectedIds(new Set())}
        onClose={() => setMoveTarget(null)}
      />

      <ConfirmDialog
        open={confirmGroup !== null}
        title={`Delete the group “${confirmGroup?.group.name ?? ''}”?`}
        message={`Its ${confirmGroup?.count ?? 0} ${confirmGroup?.count === 1 ? 'reading goes' : 'readings go'} with it, offline copies too. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          const target = confirmGroup
          setConfirmGroup(null)
          if (!target) return
          stepOffRow(target.group.id)
          deleteGroup(target.group.id)
        }}
        onCancel={() => setConfirmGroup(null)}
      />
    </div>
  )
}

/** A row's action button — card-tone backdrop (like the sidebar's close/add
 *  buttons) so icons stay readable when floated over a row or the coloured
 *  pill. */
function RowBtn({
  children,
  label,
  onClick,
  active = false,
  danger = false,
}: {
  children: React.ReactNode
  label: string
  onClick: (e: React.MouseEvent) => void
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(e) }}
      className={`flex h-7 w-7 items-center justify-center rounded bg-card/85 backdrop-blur-sm ${
        danger
          ? 'text-muted-foreground hover:bg-destructive/20 hover:text-destructive'
          : active
            ? 'text-primary hover:bg-muted'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
