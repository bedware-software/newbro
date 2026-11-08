// The Bookshelf: a reading list down the window's right-hand side, per
// profile — readings to read, in groups if you like, and an archive of the
// ones read.
//
// In Vim mode it takes the keyboard when it opens (tb), or when it's
// clicked: a cursor on its rows, driven by COMMAND's own keys — the scroll
// keys (j/k, <C-d>/<C-u>, gg/G) move it, h/l fold and unfold, Enter opens a
// reading here and Shift+Enter in a new tab, dd archives a reading (removes
// an archived one, deletes a group), dg deletes the group, u undoes the
// last dd, <C-m> is the row's menu, <C-S-j>/<C-S-k> move the row, y copies
// its address, ng makes a group of it; each row wears a two-letter label
// that opens it. Esc hands the keyboard back to the page. The keys come
// through the window's keymap (lib/vim-mode.ts usePageKeys), so the rest of
// COMMAND's keys work as ever, tb closing it again.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { TabFavicon } from './TabFavicon'
import { InlineRenameInput } from './InlineRenameInput'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'
import { MoveBookshelfDialog, type BookshelfMoveTarget } from './MoveBookshelfDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Hint, HintBar, RowHint, vimKeyCaps } from './KeyHints'
import { useHintLabels, useHintTargets } from '../lib/hint-labels'
import { usePageKeys } from '../lib/vim-mode'
import { useWindowVimKeymap } from '../lib/window-vim-keymap'
import { openAddress } from '../lib/open-address'
import { isInternalUrl } from '../lib/internal-pages'
import { log } from '../lib/log'
import {
  BookOpen, ChevronRight, ChevronDown, Download, Loader2, WifiOff,
  Pencil, Archive, ArchiveRestore, Trash2, X, Plus, FolderPlus, FolderMinus,
} from 'lucide-react'

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

export type ReadingStatus = 'toread' | 'archived'

export interface Reading {
  id: string
  url: string
  title: string
  favicon?: string
  status: ReadingStatus
  addedAt: number
  groupId?: string
  offlinePath?: string
}

export interface ReadingGroup {
  id: string
  name: string
  color: string
  isCollapsed: boolean
}

interface Props {
  open: boolean
  /** The profile this window belongs to — its shelf is the one we show. */
  profileId: string | null
  /** A page is fullscreen, which hides the shelf: its coming back when that
   *  ends isn't an opening that takes the keyboard. */
  pageFullscreen?: boolean
  /** Keys typed so far of an unfinished Vim sequence, for the row labels. */
  vimPending?: string
  onClose: () => void
}

/** A row the keyboard cursor can sit on, in the order they're drawn. */
type ShelfRow =
  | { kind: 'reading'; id: string; reading: Reading; container: string }
  | { kind: 'group'; id: string; group: ReadingGroup }
  | { kind: 'archive'; id: string }

/** What u brings back: a reading dd archived (to where it was), or an
 *  archived one dd removed. */
type ShelfUndo =
  | { kind: 'archived'; id: string; groupId: string | null; beforeId: string | null }
  | { kind: 'removed'; reading: Reading; beforeId: string | null }

const hintId = (rowId: string): string => `bookshelf:${rowId}`

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

/** COMMAND's keys while the shelf has the keyboard: mounted only then, so it
 *  comes first, over the group page's (lib/vim-mode.ts usePageKeys). */
function ShelfKeys({ intercept, command }: {
  intercept: (e: KeyboardEvent) => boolean
  command: (command: string) => boolean
}) {
  usePageKeys({ intercept, command })
  return null
}

const MIN_WIDTH = 180
const DEFAULT_WIDTH = 300
const BOOKSHELF_WIDTH_KEY = 'vimperium-bookshelf-width'

function loadWidth(): number {
  const v = localStorage.getItem(BOOKSHELF_WIDTH_KEY)
  if (!v) return DEFAULT_WIDTH
  const parsed = parseInt(v, 10)
  return Number.isFinite(parsed) ? Math.max(MIN_WIDTH, parsed) : DEFAULT_WIDTH
}

export function Bookshelf({ open, profileId, pageFullscreen = false, vimPending, onClose }: Props) {
  const [readings, setReadings] = useState<Reading[]>([])
  const [groups, setGroups] = useState<ReadingGroup[]>([])
  const [archiveCollapsed, setArchiveCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupEditValue, setGroupEditValue] = useState('')
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [moveTarget, setMoveTarget] = useState<BookshelfMoveTarget | null>(null)

  // ── Vim mode: the shelf having the keyboard ──
  // While it does, the window's COMMAND keys drive a cursor on its rows
  // (ShelfKeys, below). Null keymap: Vim mode is off, and so is all this.
  const parsedKeymap = useWindowVimKeymap()
  const vimKeymap = parsedKeymap?.main ?? null
  const rootRef = useRef<HTMLDivElement>(null)
  const [keys, setKeys] = useState(false)
  const keysRef = useRef(false)
  keysRef.current = keys
  /** The row the cursor is on; when that row goes, the one that took its
   *  place (by index). */
  const [cursorId, setCursorId] = useState<string | null>(null)
  const cursorIndexRef = useRef(0)
  const undoRef = useRef<ShelfUndo[]>([])
  const [confirmGroup, setConfirmGroup] = useState<{ group: ReadingGroup; count: number } | null>(null)
  useEffect(() => { undoRef.current = [] }, [profileId])

  /** A rename ended: the keyboard goes back to the shelf it came from. */
  const resumeKeys = (): void => {
    if (!keysRef.current) return
    setTimeout(() => rootRef.current?.focus({ preventScroll: true }), 0)
  }

  // ── Resize ──
  const [width, setWidth] = useState(loadWidth)
  const resizing = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartW = useRef(0)
  const currentW = useRef(loadWidth())

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    resizeStartX.current = e.clientX
    resizeStartW.current = currentW.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.dispatchEvent(new CustomEvent('vimperium-tab-hide'))
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const maxW = Math.floor(window.innerWidth / 2)
      const newW = Math.min(maxW, Math.max(MIN_WIDTH, resizeStartW.current - (e.clientX - resizeStartX.current)))
      currentW.current = newW
      setWidth(newW)
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(BOOKSHELF_WIDTH_KEY, String(currentW.current))
      window.dispatchEvent(new CustomEvent('vimperium-tab-show'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (resizing.current) {
        resizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.dispatchEvent(new CustomEvent('vimperium-tab-show'))
      }
    }
  }, [])

  // ── multi-select (Ctrl/Cmd = toggle, Shift = range) for group creation ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)

  // ── pointer-based drag & drop: reorder readings and groups, move readings
  // between the ungrouped list, groups and the archive ──
  const [drag, setDrag] = useState<ShelfDrag | null>(null)
  const [drop, setDrop] = useState<ShelfDrop | null>(null)
  const dropRef = useRef<ShelfDrop | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const activated = useRef(false)
  const suppressClick = useRef(false)

  // Load this profile's shelf and keep it live via the broadcast.
  useEffect(() => {
    if (!profileId) { setReadings([]); setGroups([]); return }
    let active = true
    window.electronAPI.bookshelfList?.(profileId).then((shelf) => {
      if (!active || !shelf) return
      setReadings((shelf.readings as Reading[]) || [])
      setGroups((shelf.groups as ReadingGroup[]) || [])
    })
    const cleanup = window.electronAPI.onBookshelfUpdated?.((payload) => {
      if (payload.profileId !== profileId) return
      setReadings((payload.readings as Reading[]) || [])
      setGroups((payload.groups as ReadingGroup[]) || [])
    })
    return () => { active = false; cleanup?.() }
  }, [profileId])

  /** Show the shelf a reorder hands back right away instead of waiting for the
   *  debounced broadcast, which holding J/K would outrun. */
  const applyShelf = useCallback((shelf: { readings: Reading[]; groups: ReadingGroup[] } | undefined) => {
    if (!shelf) return
    setReadings(shelf.readings || [])
    setGroups(shelf.groups || [])
  }, [])

  const openReading = useCallback((r: Reading, offline: boolean) => {
    const s = useAppStore.getState()
    const url = offline && r.offlinePath
      ? `file:///${r.offlinePath.replace(/\\/g, '/')}`
      : r.url
    if (s.activeWorkspaceId) s.addTabNearActive(s.activeWorkspaceId, url)
  }, [])

  const commitRename = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfUpdate?.(profileId, id, { title: editValue })
    setEditingId(null)
    setEditValue('')
    resumeKeys()
    // resumeKeys reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Save the window's current page to the shelf (header "+" button).
  const addCurrentPage = useCallback(() => {
    if (!profileId) return
    const tab = useAppStore.getState().getActiveTab()
    if (!tab) return
    window.electronAPI.bookshelfAdd?.(profileId, { url: tab.url, title: tab.title, favicon: tab.favicon })
  }, [profileId])

  // ── group ops ──
  // Create a new group, file the given readings into it (if any), and drop
  // straight into rename. Shared by the header button and the context menu.
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

  // Header folder-plus button: group the current selection (or make an empty
  // group when nothing is selected).
  const createGroup = useCallback(() => { groupReadings([...selectedIds]) }, [groupReadings, selectedIds])

  // Ordered reading ids (display order) so Shift range-select matches the eye.
  const orderedIds = useCallback((): string[] => {
    const ids: string[] = []
    for (const r of readings) if (r.status === 'toread' && !r.groupId) ids.push(r.id)
    for (const g of groups) for (const r of readings) if (r.status === 'toread' && r.groupId === g.id) ids.push(r.id)
    for (const r of readings) if (r.status === 'archived') ids.push(r.id)
    return ids
  }, [readings, groups])

  const handleReadingClick = useCallback((r: Reading, e: React.MouseEvent) => {
    if (suppressClick.current) return // a drag just ended — don't treat as a click
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
  }, [orderedIds, openReading])

  const commitGroupRename = useCallback((id: string) => {
    if (profileId) window.electronAPI.bookshelfUpdateGroup?.(profileId, id, { name: groupEditValue })
    setEditingGroupId(null)
    setGroupEditValue('')
    resumeKeys()
    // resumeKeys reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── right-click context menus (reuse the sidebar's dropdown popup) ──
  /** Opened from the keyboard (<C-m>), a menu takes it — its first action
   *  highlighted, a key on each — and gives it back to the shelf after. */
  const showMenu = async (spec: Parameters<typeof openDropdownAsync>[0], keyboard: boolean) => {
    const result = await openDropdownAsync(keyboard ? { ...spec, keyboard: true } : spec)
    if (keyboard && keysRef.current) {
      reclaimRendererFocus()
      rootRef.current?.focus({ preventScroll: true })
    }
    return result
  }

  const openGroupMenu = useCallback(async (g: ReadingGroup, at: MenuPoint, keyboard = false) => {
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
    else if (result.actionId === 'duplicate-group') duplicate([g.id], false)
    else if (result.actionId === 'ungroup') ungroup(g.id)
    else if (result.actionId === 'delete') deleteGroup(g.id)
  }, [profileId, readings, toggleGroup, duplicate, ungroup, deleteGroup])

  const openReadingMenu = useCallback(async (r: Reading, at: MenuPoint, keyboard = false) => {
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
      case 'save-offline': saveOffline(r.id); break
      case 'duplicate': duplicate(targets, true); break
      case 'new-group': groupReadings(targets); break
      case 'move': setMoveTarget({ kind: 'readings', ids: targets }); break
      case 'ungroup-reading': window.electronAPI.bookshelfMoveReading?.(profileId, r.id, null); break
      case 'archive': setStatus(r.id, 'archived'); break
      case 'unarchive': setStatus(r.id, 'toread'); break
      case 'remove':
        for (const id of targets) remove(id)
        setSelectedIds(new Set())
        break
    }
  }, [profileId, selectedIds, openReading, saveOffline, duplicate, setStatus, remove, groupReadings])

  // ── drag handlers ──
  /** A container's readings in display order. */
  const containerReadings = useCallback((key: string): Reading[] => {
    if (key === UNGROUPED) return readings.filter((r) => r.status === 'toread' && !r.groupId)
    if (key === ARCHIVE_ROW_ID) return readings.filter((r) => r.status === 'archived')
    return readings.filter((r) => r.status === 'toread' && r.groupId === key)
  }, [readings])

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
    window.dispatchEvent(new CustomEvent('vimperium-tab-show'))
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

  const startDrag = useCallback((item: ShelfDrag, e: React.MouseEvent) => {
    // Modifier-clicks are multi-select, not drags — let them through to onClick.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    startPos.current = { x: e.clientX, y: e.clientY }
    activated.current = false
    const onMove = (me: MouseEvent) => {
      if (!startPos.current) return
      const moved = Math.abs(me.clientX - startPos.current.x) + Math.abs(me.clientY - startPos.current.y)
      if (!activated.current && moved < 6) return
      if (!activated.current) {
        activated.current = true
        suppressClick.current = true
        setDrag(item)
        // Zero out the page's view so it can't swallow the pointer mid-drag.
        window.dispatchEvent(new CustomEvent('vimperium-tab-hide'))
      }
      computeDropRef.current(me.clientY, item)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (activated.current) finishRef.current(item)
      startPos.current = null
      activated.current = false
      // Let the row's click fire first and be swallowed, then re-enable.
      setTimeout(() => { suppressClick.current = false }, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Vim mode: the keyboard on the shelf ──

  // The rows the cursor goes through, as drawn: To Read's ungrouped
  // readings, each group's header and (unfolded) readings, the Archive's
  // header and (unfolded) readings.
  const rows = useMemo<ShelfRow[]>(() => {
    const out: ShelfRow[] = []
    for (const r of readings) if (r.status === 'toread' && !r.groupId) out.push({ kind: 'reading', id: r.id, reading: r, container: UNGROUPED })
    for (const g of groups) {
      out.push({ kind: 'group', id: g.id, group: g })
      if (g.isCollapsed) continue
      for (const r of readings) if (r.status === 'toread' && r.groupId === g.id) out.push({ kind: 'reading', id: r.id, reading: r, container: g.id })
    }
    const archivedReadings = readings.filter((r) => r.status === 'archived')
    if (archivedReadings.length > 0) {
      out.push({ kind: 'archive', id: ARCHIVE_ROW_ID })
      if (!archiveCollapsed) for (const r of archivedReadings) out.push({ kind: 'reading', id: r.id, reading: r, container: ARCHIVE_ROW_ID })
    }
    return out
  }, [readings, groups, archiveCollapsed])

  const foundAt = cursorId ? rows.findIndex((r) => r.id === cursorId) : -1
  const cursorAt = rows.length === 0 ? -1 : foundAt !== -1 ? foundAt : Math.min(cursorIndexRef.current, rows.length - 1)
  cursorIndexRef.current = Math.max(cursorAt, 0)
  const cursorRow = cursorAt === -1 ? null : rows[cursorAt]
  const editing = editingId !== null || editingGroupId !== null

  const findRowEl = (id: string): Element | null =>
    listRef.current?.querySelector(`[data-shelf-row="${CSS.escape(id)}"]`) ?? null
  useEffect(() => {
    if (keys && cursorRow) findRowEl(cursorRow.id)?.scrollIntoView({ block: 'nearest' })
    // findRowEl reads the DOM as it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, cursorRow?.id, rows])

  /** The keyboard to the shelf: the window's renderer takes it from the
   *  page, and the shelf's root the renderer's. A click has already given
   *  the renderer the keyboard — and what it clicked may hand it on (a
   *  reading opening), which mustn't be taken back. */
  const takeKeyboard = useCallback((byClick = false) => {
    if (!parsedKeymap) return
    keysRef.current = true
    setKeys(true)
    if (!byClick) window.electronAPI.focusWindowRenderer?.()
    rootRef.current?.focus({ preventScroll: true })
    if (byClick) return
    // A tab view still pulling focus back gets it taken from it again.
    for (const delay of [60, 180]) {
      setTimeout(() => {
        if (!keysRef.current) return
        if (!document.hasFocus()) window.electronAPI.reclaimWindowRendererFocus?.()
        const root = rootRef.current
        if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true })
      }, delay)
    }
  }, [parsedKeymap])

  /** The keyboard leaves the shelf; `toPage`: to the active tab's page. */
  const releaseKeyboard = useCallback((toPage: boolean) => {
    if (!keysRef.current) return
    keysRef.current = false
    setKeys(false)
    const root = rootRef.current
    const focused = document.activeElement
    if (root && focused instanceof HTMLElement && root.contains(focused)) focused.blur()
    if (!toPage) return
    const s = useAppStore.getState()
    if (s.activeTabId && !isInternalUrl(s.getActiveTab()?.url)) void window.electronAPI.tabFocus?.(s.activeTabId)
  }, [])

  // Opening takes the keyboard — every way to open the shelf is a command
  // (tb, the palette) — but not its coming back after a fullscreen page,
  // nor the window starting with it open. Closing with it gives it back.
  const wasOpenRef = useRef(open)
  const wasFullscreenRef = useRef(pageFullscreen)
  useEffect(() => {
    const was = wasOpenRef.current
    const wasFullscreen = wasFullscreenRef.current
    wasOpenRef.current = open
    wasFullscreenRef.current = pageFullscreen
    if (open && !was && !wasFullscreen) takeKeyboard()
    else if (!open && was) releaseKeyboard(!pageFullscreen)
  }, [open, pageFullscreen, takeKeyboard, releaseKeyboard])
  // Vim mode turned off: nothing has the shelf's keys any more.
  useEffect(() => { if (!parsedKeymap) releaseKeyboard(false) }, [parsedKeymap, releaseKeyboard])

  // It keeps the keyboard until the keyboard goes elsewhere: the page takes
  // it, or focus moves on in the window. Focus leaving for another window
  // (a row menu, a dialog) leaves the shelf's root focused, which it comes
  // back to.
  useEffect(() => {
    if (!keys) return
    const root = rootRef.current
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null
      if (next && root?.contains(next)) return
      if (next) {
        releaseKeyboard(false)
        return
      }
      setTimeout(() => {
        const r = rootRef.current
        if (keysRef.current && (!r || !r.contains(document.activeElement))) releaseKeyboard(false)
      }, 0)
    }
    root?.addEventListener('focusout', onFocusOut)
    const cleanupTabEvents = window.electronAPI.onTabEvent?.((raw) => {
      if ((raw as { type?: string }).type === 'focus') releaseKeyboard(false)
    })
    return () => {
      root?.removeEventListener('focusout', onFocusOut)
      cleanupTabEvents?.()
    }
  }, [keys, releaseKeyboard])

  const moveCursorTo = (index: number): void => {
    if (rows.length === 0) return
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))]
    setCursorId(row.id)
  }
  const halfPage = (): number => {
    const list = listRef.current
    const row = list?.querySelector('[data-shelf-row]') as HTMLElement | null
    if (!list || !row || row.offsetHeight === 0) return 8
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight / 2))
  }
  /** Before a row goes (a group with its readings): the cursor onto the one
   *  after it, or before. */
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
  const logShelfError = (what: string) => (err: unknown): void => {
    log.warn(`bookshelf: ${what} failed`, { err: String(err) })
  }

  /** Enter (`here`), Shift+Enter (`new-tab`) or a label on a row: a
   *  reading opens, a header folds or unfolds. */
  const activateRow = (row: ShelfRow, how: 'here' | 'new-tab'): void => {
    setCursorId(row.id)
    if (row.kind === 'group') toggleGroup(row.group)
    else if (row.kind === 'archive') setArchiveCollapsed((v) => !v)
    else if (how === 'new-tab') {
      releaseKeyboard(false)
      openReading(row.reading, false)
    } else {
      releaseKeyboard(false)
      if (openAddress(row.reading.url, false, 'bookshelf')) {
        const s = useAppStore.getState()
        if (s.activeTabId && !isInternalUrl(row.reading.url)) void window.electronAPI.tabFocus?.(s.activeTabId)
      }
    }
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
  const deleteRow = (row: ShelfRow | null): void => {
    if (!row || !profileId) return
    if (row.kind === 'group') {
      askDeleteGroup(row.group)
      return
    }
    if (row.kind !== 'reading') return
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
  }

  /** u: the last dd undone, the reading back where it was. */
  const undo = (): void => {
    const last = undoRef.current.pop()
    if (!last || !profileId) return
    const api = window.electronAPI
    if (last.kind === 'archived') {
      setCursorId(last.id)
      api.bookshelfPlaceReadings?.(profileId, [last.id], { groupId: last.groupId }, last.beforeId)
        .then(applyShelf)
        .catch(logShelfError('undoing the archive'))
      return
    }
    // Removed for good: added again, then put back in the Archive. Its
    // offline copy went with it.
    const { reading, beforeId } = last
    api.bookshelfAdd?.(profileId, { url: reading.url, title: reading.title, favicon: reading.favicon })
      .then((added) => {
        if (!added) return
        setCursorId(added.id)
        return api.bookshelfPlaceReadings?.(profileId, [added.id], { groupId: null, archived: true }, beforeId).then(applyShelf)
      })
      .catch(logShelfError('undoing the removal'))
  }

  /** h / l: a header folds or unfolds; on a reading in a folder, h folds
   *  it and goes to its header, l on an unfolded header steps in. */
  const foldRow = (unfold: boolean): void => {
    const row = cursorRow
    if (!row) return
    if (row.kind === 'group') {
      if (row.group.isCollapsed === unfold) toggleGroup(row.group)
      else if (unfold) moveCursorTo(cursorAt + 1)
      return
    }
    if (row.kind === 'archive') {
      if (archiveCollapsed === unfold) setArchiveCollapsed(!unfold)
      else if (unfold) moveCursorTo(cursorAt + 1)
      return
    }
    if (unfold) return
    if (row.container === ARCHIVE_ROW_ID) {
      setArchiveCollapsed(true)
      setCursorId(ARCHIVE_ROW_ID)
      return
    }
    const group = groupOf(row)
    if (!group) return
    if (!group.isCollapsed) toggleGroup(group)
    setCursorId(group.id)
  }

  /** <C-S-j> / <C-S-k>: the row one down or up. A reading moves within its
   *  list, and on from either end of a To Read list into the next one (a
   *  group it goes into unfolds); a group swaps with its neighbour. */
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
    }
    api.bookshelfPlaceReadings?.(profileId, [row.id], placeTarget(container), beforeId)
      .then(applyShelf)
      .catch(logShelfError('moving the reading'))
  }

  /** <C-m>: the cursor row's menu, keyboard and all. */
  const openRowMenu = (): void => {
    const row = cursorRow
    if (!row || row.kind === 'archive') return
    const rect = findRowEl(row.id)?.getBoundingClientRect()
    const at = rect ? { x: rect.left + 24, y: rect.bottom } : { x: window.innerWidth - 240, y: 80 }
    const failed = logShelfError('the row menu')
    if (row.kind === 'group') openGroupMenu(row.group, at, true).catch(failed)
    else openReadingMenu(row.reading, at, true).catch(failed)
  }

  /** ng: a new group — of the reading under the cursor, if it's one to
   *  read — named at once. */
  const newGroup = (): void => {
    const row = cursorRow
    const ids = row?.kind === 'reading' && row.reading.status === 'toread' ? [row.id] : []
    groupReadings(ids)
      .then(() => { if (ids[0]) setCursorId(ids[0]) })
      .catch(logShelfError('making a group'))
  }

  const shelfIntercept = (e: KeyboardEvent): boolean => {
    if (editing || e.ctrlKey || e.metaKey || e.altKey) return false
    if (e.key === 'Escape') {
      releaseKeyboard(true)
      return true
    }
    if (e.key === 'Enter') {
      if (cursorRow) activateRow(cursorRow, e.shiftKey ? 'new-tab' : 'here')
      return true
    }
    return false
  }

  const shelfCommand = (command: string): boolean => {
    if (editing) return false
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
      // The shelf's own: they mustn't reach the active tab or its group.
      case 'close-tab': deleteRow(cursorRow); return true
      case 'close-group': {
        const group = groupOf(cursorRow)
        if (group) askDeleteGroup(group)
        return true
      }
      case 'reopen-closed-tab': undo(); return true
      case 'new-group': newGroup(); return true
      case 'copy-url':
        // The reading's address, not the page's.
        if (cursorRow?.kind === 'reading') window.electronAPI.clipboardWriteText(cursorRow.reading.url)
        return true
    }
    return false
  }

  // COMMAND's labels on the rows while the shelf has the keyboard (lib/
  // hint-labels.ts): typing one does what Enter on it would.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useHintTargets('bookshelf', 1, open && keys && !editing
    ? rows.map((row) => ({
      id: hintId(row.id),
      activate: () => {
        const current = rowsRef.current.find((r) => r.id === row.id)
        if (current) activateRow(current, 'here')
      },
    }))
    : null)
  const hintLabels = useHintLabels()

  /** The cursor's ring and the row's label, while the shelf has the keys. */
  const rowKeys = (rowId: string): { cursor: boolean; hint: React.ReactNode } => {
    const cursor = keys && cursorRow?.id === rowId
    const label = keys && !editing ? hintLabels.get(hintId(rowId)) : undefined
    return {
      cursor,
      hint: label
        ? <RowHint mode="command" label={label} number={0} pending={vimPending} className="absolute left-0.5 top-1/2 -translate-y-1/2 bg-toolbar" />
        : null,
    }
  }
  const cursorClass = 'bg-accent text-foreground ring-1 ring-inset ring-primary/70'

  if (!open) return null

  const ungrouped = readings.filter((r) => r.status === 'toread' && !r.groupId)
  const archived = readings.filter((r) => r.status === 'archived')
  const inGroup = (gid: string) => readings.filter((r) => r.status === 'toread' && r.groupId === gid)
  const isEmpty = readings.length === 0 && groups.length === 0

  const isDropInto = (container: string): boolean =>
    drop?.type === 'reading' && drop.into && drop.container === container
  const isDropAtEnd = (container: string): boolean =>
    drop?.type === 'reading' && !drop.into && drop.container === container && drop.beforeId === null

  const renderRow = (r: Reading, isArchived: boolean) => {
    const saving = savingIds.has(r.id)
    const hasOffline = !!r.offlinePath
    if (editingId === r.id) {
      return (
        <div key={r.id} data-sidebar-row="" className="relative flex items-center gap-1 px-1 py-1">
          <TabFavicon favicon={r.favicon} />
          <InlineRenameInput
            value={editValue}
            onChange={setEditValue}
            onCommit={() => commitRename(r.id)}
            onCancel={() => { setEditingId(null); setEditValue(''); resumeKeys() }}
            className="flex-1 min-w-0 field rounded-md px-1.5 py-0.5 text-xs text-foreground outline-none"
          />
        </div>
      )
    }
    const selected = selectedIds.has(r.id)
    const dragged = drag?.type === 'reading' && drag.ids.includes(r.id)
    const vim = rowKeys(r.id)
    return (
      <div
        key={r.id}
        data-sidebar-row=""
        data-shelf-row={r.id}
        // Vim's ; (chrome-hints) labels it: typing the label clicks the row.
        data-chrome-hint=""
        data-drop-reading={r.id}
        data-drop-container={isArchived ? ARCHIVE_ROW_ID : r.groupId ?? UNGROUPED}
        className={`relative flex items-center gap-1 px-1 py-1 cursor-pointer group/row transition-colors ${
          vim.cursor ? cursorClass : selected ? 'bg-primary/20 text-foreground' : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
        } ${dragged ? 'opacity-30' : isArchived && !vim.cursor ? 'opacity-60' : ''}`}
        title={r.url}
        onMouseDown={(e) => {
          // A selected row carries the whole selection, in display order.
          const ids = selected && selectedIds.size > 1
            ? orderedIds().filter((id) => selectedIds.has(id))
            : [r.id]
          startDrag({ type: 'reading', ids }, e)
        }}
        onClick={(e) => handleReadingClick(r, e)}
        onContextMenu={(e) => openReadingMenu(r, contextMenuPoint(e))}
      >
        {drop?.type === 'reading' && !drop.into && drop.beforeId === r.id && <DropLine />}
        {vim.hint}
        <TabFavicon favicon={r.favicon} />
        <span className="flex-1 text-xs truncate">{r.title}</span>
        {/* Action overlay floated at the right edge so it never changes the
            row height — same pattern as the sidebar's close button. */}
        <div className="absolute right-1 top-0 bottom-0 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity pointer-events-none group-hover/row:pointer-events-auto">
          <HeaderBtn label="Rename" onClick={() => { setEditingId(r.id); setEditValue(r.title) }}>
            <Pencil size={12} />
          </HeaderBtn>
          {saving ? (
            <span className="flex h-6 w-6 items-center justify-center rounded bg-card/85 backdrop-blur-sm text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
            </span>
          ) : (
            <HeaderBtn
              label={hasOffline ? 'Open offline copy' : 'Save for offline'}
              onClick={() => { if (hasOffline) openReading(r, true); else saveOffline(r.id) }}
              active={hasOffline}
            >
              {hasOffline ? <WifiOff size={12} /> : <Download size={12} />}
            </HeaderBtn>
          )}
          {isArchived ? (
            <HeaderBtn label="Move to To Read" onClick={() => setStatus(r.id, 'toread')}>
              <ArchiveRestore size={12} />
            </HeaderBtn>
          ) : (
            <HeaderBtn label="Archive" onClick={() => setStatus(r.id, 'archived')}>
              <Archive size={12} />
            </HeaderBtn>
          )}
          <HeaderBtn label="Remove" onClick={() => remove(r.id)} danger>
            <Trash2 size={12} />
          </HeaderBtn>
        </div>
      </div>
    )
  }

  const renderGroup = (g: ReadingGroup) => {
    const items = inGroup(g.id)
    const groupKeys = rowKeys(g.id)
    return (
      <div
        key={g.id}
        data-group-container=""
        data-drop-group-block={g.id}
        className={`relative ${drag?.type === 'group' && drag.id === g.id ? 'opacity-30' : ''}`}
        style={{ ['--gc' as string]: g.color }}
      >
        {drop?.type === 'group' && drop.beforeId === g.id && <DropLine />}
        {/* Header mirrors the sidebar tab-group: a colored count badge on the
            leading edge, then an Edge-style colored pill that swallows the
            collapse chevron + name. Colors come from globals.css via --gc. */}
        <div
          data-sidebar-row=""
          data-sidebar-group-row=""
          data-shelf-row={g.id}
          // Vim's ; (chrome-hints) labels it: typing the label clicks the row.
          data-chrome-hint=""
          data-drop-into={g.id}
          {...(!g.isCollapsed && items.length > 0 ? { 'data-group-expanded': '' } : {})}
          className={`group/gh relative flex items-center gap-1 px-1 py-1 cursor-pointer ${
            isDropInto(g.id) ? 'bg-primary/30 ring-1 ring-inset ring-primary/40' : groupKeys.cursor ? cursorClass : 'hover:bg-accent'
          }`}
          onMouseDown={(e) => { if (editingGroupId !== g.id) startDrag({ type: 'group', id: g.id }, e) }}
          onClick={() => { if (!suppressClick.current && editingGroupId !== g.id) toggleGroup(g) }}
          onContextMenu={(e) => openGroupMenu(g, contextMenuPoint(e))}
        >
          {groupKeys.hint}
          <span
            data-group-badge=""
            className="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-[10px] font-semibold tabular-nums leading-none"
            title={`${items.length} ${items.length === 1 ? 'reading' : 'readings'}`}
          >
            {items.length}
          </span>
          <span
            data-group-pill=""
            className="inline-flex items-center gap-1 min-w-0 max-w-full pl-1.5 pr-3 py-1 rounded-md text-xs font-medium overflow-hidden"
          >
            <span className="shrink-0 inline-flex items-center">
              {g.isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </span>
            {editingGroupId === g.id ? (
              <InlineRenameInput
                value={groupEditValue}
                onChange={setGroupEditValue}
                onCommit={() => commitGroupRename(g.id)}
                onCancel={() => { setEditingGroupId(null); setGroupEditValue(''); resumeKeys() }}
                className="flex-1 min-w-0 bg-transparent outline-none text-inherit placeholder:opacity-60"
              />
            ) : (
              <span className="flex-1 min-w-0 truncate">{g.name}</span>
            )}
          </span>
          {/* Action overlay floated above the pill so the pill keeps the full
              row width; card-tone backdrop keeps icons legible over the pill. */}
          <div className="absolute right-1 top-0 bottom-0 flex items-center gap-1 opacity-0 group-hover/gh:opacity-100 transition-opacity pointer-events-none group-hover/gh:pointer-events-auto">
            <HeaderBtn label="Rename group" onClick={() => { setEditingGroupId(g.id); setGroupEditValue(g.name) }}>
              <Pencil size={13} />
            </HeaderBtn>
            <HeaderBtn label="Ungroup (keep readings)" onClick={() => ungroup(g.id)}>
              <FolderMinus size={13} />
            </HeaderBtn>
            <HeaderBtn label="Delete group & its readings" danger onClick={() => deleteGroup(g.id)}>
              <Trash2 size={13} />
            </HeaderBtn>
          </div>
        </div>
        {!g.isCollapsed && (
          <div data-group-children="">
            {items.length === 0 ? (
              <div data-drop-into={g.id} className="px-2 py-1.5 pl-3 text-[10px] text-muted-foreground/60">Drop readings here</div>
            ) : (
              items.map((r) => renderRow(r, false))
            )}
            {isDropAtEnd(g.id) && items.length > 0 && <EndDropLine />}
          </div>
        )}
      </div>
    )
  }

  const archiveKeys = rowKeys(ARCHIVE_ROW_ID)
  // What dd does to the row under the cursor, for the hint bar.
  const deleteLabel = cursorRow?.kind === 'group' ? 'Delete'
    : cursorRow?.kind === 'reading' && cursorRow.reading.status === 'archived' ? 'Remove'
    : 'Archive'

  return (
    <div
      ref={rootRef}
      // Focused while it has the keyboard (Vim mode), the keys arriving on
      // the window: no outline, the cursor shows where they go.
      tabIndex={-1}
      role="region"
      aria-label="Bookshelf"
      style={{ width }}
      className="bg-toolbar border-l border-border flex flex-col shrink-0 overflow-hidden select-none relative outline-none"
      onMouseDown={(e) => {
        // A click into it hands it the keyboard — not one on a field — with
        // the cursor on the row clicked.
        const target = e.target as HTMLElement
        if (!parsedKeymap || target.closest('input, textarea')) return
        const rowId = target.closest<HTMLElement>('[data-shelf-row]')?.dataset.shelfRow
        if (rowId) setCursorId(rowId)
        if (!keys) takeKeyboard(true)
      }}
    >
      {keys && <ShelfKeys intercept={shelfIntercept} command={shelfCommand} />}
      <div className="flex items-center gap-1 px-3 h-10 border-b border-border shrink-0">
        <BookOpen size={15} className={keys ? 'text-primary' : 'text-muted-foreground'} />
        <span className="text-sm font-medium text-foreground flex-1 ml-1">Bookshelf</span>
        <button
          aria-label="Add current page"
          title="Add current page to Bookshelf"
          onClick={addCurrentPage}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="New group"
          title={selectedIds.size > 0 ? `New group from ${selectedIds.size} selected` : 'New group'}
          onClick={createGroup}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <FolderPlus size={15} />
        </button>
        <button
          aria-label="Close Bookshelf"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto min-h-0 py-1">
        <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
          <span>To Read{ungrouped.length > 0 ? ` · ${ungrouped.length}` : ''}</span>
          {selectedIds.size > 0 && (
            <span className="text-primary normal-case">{selectedIds.size} selected · ⇧/⌃-click</span>
          )}
        </div>

        <div
          // Once it's empty, the whole strip takes a drop back into To Read.
          {...(ungrouped.length === 0 ? { 'data-drop-into': UNGROUPED } : {})}
          className={`transition-colors ${isDropInto(UNGROUPED) ? 'ring-1 ring-inset ring-primary/50 bg-primary/5' : ''}`}
          style={{ minHeight: ungrouped.length === 0 && !isEmpty ? 12 : undefined }}
        >
          {isEmpty ? (
            <div className="px-2 py-3 text-xs text-muted-foreground/70">
              Nothing here yet. Hit “+” to save the current page; Shift/Ctrl-click readings, then the folder icon to group them.
            </div>
          ) : (
            ungrouped.map((r) => renderRow(r, false))
          )}
          {isDropAtEnd(UNGROUPED) && ungrouped.length > 0 && <EndDropLine />}
        </div>

        {groups.map(renderGroup)}
        {drop?.type === 'group' && drop.beforeId === null && groups.length > 0 && <EndDropLine />}

        {archived.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              data-drop-into={ARCHIVE_ROW_ID}
              data-shelf-row={ARCHIVE_ROW_ID}
              onClick={() => setArchiveCollapsed((v) => !v)}
              className={`relative w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                isDropInto(ARCHIVE_ROW_ID)
                  ? 'bg-primary/30 ring-1 ring-inset ring-primary/40 text-foreground'
                  : archiveKeys.cursor ? cursorClass : 'text-muted-foreground/80 hover:text-foreground'
              }`}
            >
              {archiveKeys.hint}
              {archiveCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              Archive · {archived.length}
            </button>
            {!archiveCollapsed && archived.map((r) => renderRow(r, true))}
            {!archiveCollapsed && isDropAtEnd(ARCHIVE_ROW_ID) && <EndDropLine />}
          </div>
        )}
      </div>

      {/* Its keys while it has the keyboard, the Sidebar's way: wrapping. */}
      {keys && (
        <HintBar wrap className="px-2">
          <Hint label="Move" keys={vimKeyCaps(vimKeymap, 'scroll-down', 'scroll-up')} />
          <Hint label="Open" keys={['Enter']} />
          <Hint label="New tab" keys={['⇧Enter']} />
          <Hint label="Fold" keys={vimKeyCaps(vimKeymap, 'back', 'forward')} />
          <Hint label="Menu" keys={vimKeyCaps(vimKeymap, 'row-menu')} />
          <Hint label={deleteLabel} keys={vimKeyCaps(vimKeymap, 'close-tab')} />
          <Hint label="Undo" keys={vimKeyCaps(vimKeymap, 'reopen-closed-tab')} />
          <Hint label="Reorder" keys={vimKeyCaps(vimKeymap, 'row-move-down', 'row-move-up')} />
          <Hint label="To the page" keys={['Esc']} />
        </HintBar>
      )}

      <div
        className="absolute top-0 left-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
        onMouseDown={onResizeStart}
      />

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

/** Row/header action button — card-tone backdrop (like the sidebar's close/add
 *  buttons) so icons stay readable when floated over a row or the colored pill. */
function HeaderBtn({
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
      className={`flex h-6 w-6 items-center justify-center rounded bg-card/85 backdrop-blur-sm ${
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
