import { useState, useEffect, useCallback, useRef } from 'react'
import { useAppStore } from '../store/app-store'
import { TabFavicon } from './TabFavicon'
import { InlineRenameInput } from './InlineRenameInput'
import { openDropdownAsync, type DropdownAction, type DropdownSpec } from './dropdown-protocol'
import { useVimNav, type VimCommand } from '../lib/vim-nav'
import { MoveBookshelfDialog, type BookshelfMoveTarget } from './MoveBookshelfDialog'
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

/** Rows vim mode steps through, in display order. */
type ShelfRow =
  | { kind: 'reading'; id: string; reading: Reading }
  | { kind: 'group'; id: string; group: ReadingGroup }
  | { kind: 'archive'; id: string }

const ARCHIVE_ROW_ID = '__archive__'

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
  onClose: () => void
  /** Vim mode: a block cursor on one row, driven by hjkl & co. */
  vimActive: boolean
  /** Leave vim mode; `focusPage` hands the keyboard back to the page. */
  onVimExit: (focusPage: boolean) => void
}

const MIN_WIDTH = 180
const DEFAULT_WIDTH = 300
const BOOKSHELF_WIDTH_KEY = 'newbro-bookshelf-width'

function loadWidth(): number {
  const v = localStorage.getItem(BOOKSHELF_WIDTH_KEY)
  if (!v) return DEFAULT_WIDTH
  const parsed = parseInt(v, 10)
  return Number.isFinite(parsed) ? Math.max(MIN_WIDTH, parsed) : DEFAULT_WIDTH
}

export function Bookshelf({ open, profileId, onClose, vimActive, onVimExit }: Props) {
  const [readings, setReadings] = useState<Reading[]>([])
  const [groups, setGroups] = useState<ReadingGroup[]>([])
  const [archiveCollapsed, setArchiveCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupEditValue, setGroupEditValue] = useState('')
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const [moveTarget, setMoveTarget] = useState<BookshelfMoveTarget | null>(null)

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
    window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
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
      window.dispatchEvent(new CustomEvent('newbro-tab-show'))
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
        window.dispatchEvent(new CustomEvent('newbro-tab-show'))
      }
    }
  }, [])

  // ── multi-select (Ctrl/Cmd = toggle, Shift = range) for group creation ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)

  // ── pointer-based drag (move a reading into a group / out to ungrouped) ──
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropZone, setDropZone] = useState<string | null>(null) // group id or 'ungrouped'
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

  // ── vim mode ──
  // The shelf has no "active" row, so the cursor is its own state. It stays
  // where it was between visits and falls back to the first row when that
  // row is gone.
  const [vimCursorId, setVimCursorId] = useState<string | null>(null)
  const listVimRows = (): ShelfRow[] => {
    const rows: ShelfRow[] = []
    for (const r of readings) if (r.status === 'toread' && !r.groupId) rows.push({ kind: 'reading', id: r.id, reading: r })
    for (const g of groups) {
      rows.push({ kind: 'group', id: g.id, group: g })
      if (g.isCollapsed) continue
      for (const r of readings) if (r.status === 'toread' && r.groupId === g.id) rows.push({ kind: 'reading', id: r.id, reading: r })
    }
    if (readings.some((r) => r.status === 'archived')) {
      rows.push({ kind: 'archive', id: ARCHIVE_ROW_ID })
      if (!archiveCollapsed) for (const r of readings) if (r.status === 'archived') rows.push({ kind: 'reading', id: r.id, reading: r })
    }
    return rows
  }
  const vimRows = listVimRows()
  const vimCursor = vimRows.find((row) => row.id === vimCursorId) ?? vimRows[0] ?? null
  const { runMenu } = useVimNav(
    open && vimActive,
    (cmd) => handleVimCommand(cmd),
    () => onVimExit(false),
  )
  const findVimRow = (id: string): Element | null =>
    listRef.current?.querySelector(`[data-vim-row="${CSS.escape(id)}"]`) ?? null
  useEffect(() => {
    if (!open || !vimActive || !vimCursor) return
    findVimRow(vimCursor.id)?.scrollIntoView({ block: 'nearest' })
  }, [open, vimActive, vimCursor?.id])

  /** Opens a shelf menu. One opened from vim mode (m) takes the keyboard:
   *  its first action starts highlighted and hjkl move around it. */
  const showMenu = useCallback((spec: Omit<DropdownSpec, 'openerId'>, keyboard: boolean) =>
    keyboard
      ? runMenu(() => openDropdownAsync({ ...spec, keyboard: true }))
      : openDropdownAsync(spec),
  [runMenu])

  // ── right-click context menus (reuse the sidebar's dropdown popup) ──
  const openGroupMenu = useCallback(async (g: ReadingGroup, at: MenuPoint, keyboard = false) => {
    if (!profileId) return
    const count = readings.filter((r) => r.status === 'toread' && r.groupId === g.id).length
    const actions: DropdownAction[] = [
      { id: 'rename', label: 'Rename Group', iconName: 'Pencil' },
      { id: 'collapse', label: g.isCollapsed ? 'Expand Group' : 'Collapse Group', iconName: 'Folder' },
      { id: 'move-group', label: 'Move Group…', iconName: 'FolderInput', divider: 'before' },
      { id: 'duplicate-group', label: 'Duplicate Group', iconName: 'CopyPlus' },
      { id: 'ungroup', label: 'Ungroup (keep readings)', iconName: 'FolderMinus', divider: 'before' },
      {
        id: 'delete',
        label: `Delete Group (${count} ${count === 1 ? 'reading' : 'readings'})`,
        iconName: 'Trash2',
        destructive: true,
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
  }, [profileId, readings, showMenu, toggleGroup, duplicate, ungroup, deleteGroup])

  const openReadingMenu = useCallback(async (r: Reading, at: MenuPoint, keyboard = false) => {
    if (!profileId) return
    // Right-clicking one of the multi-selected readings acts on the whole
    // selection (same as the sidebar's tab context menu).
    const useSelection = selectedIds.has(r.id) && selectedIds.size > 1
    const targets = useSelection ? [...selectedIds] : [r.id]
    const hasOffline = !!r.offlinePath
    const actions: DropdownAction[] = []
    if (!useSelection) {
      actions.push({ id: 'open', label: 'Open', iconName: 'Globe' })
      if (hasOffline) actions.push({ id: 'open-offline', label: 'Open Offline Copy', iconName: 'Download' })
      actions.push({ id: 'rename', label: 'Rename', iconName: 'Pencil', divider: 'before' })
      actions.push({ id: 'save-offline', label: hasOffline ? 'Re-save Offline' : 'Save for Offline', iconName: 'Download' })
    }
    actions.push({
      id: 'duplicate',
      label: useSelection ? `Duplicate ${targets.length} Readings` : 'Duplicate',
      iconName: 'CopyPlus',
    })
    actions.push({
      id: 'new-group',
      label: useSelection ? `Add ${targets.length} Readings to New Group` : 'Add to New Group',
      iconName: 'FolderPlus',
      divider: 'before',
    })
    if (!useSelection && r.groupId) actions.push({ id: 'ungroup-reading', label: 'Remove from Group', iconName: 'FolderMinus' })
    actions.push({
      id: 'move',
      label: useSelection ? `Move ${targets.length} Readings…` : 'Move…',
      iconName: 'FolderInput',
    })
    if (!useSelection) {
      if (r.status === 'archived') actions.push({ id: 'unarchive', label: 'Move to To Read', iconName: 'FolderInput', divider: 'before' })
      else actions.push({ id: 'archive', label: 'Archive', iconName: 'EyeOff', divider: 'before' })
    }
    actions.push({
      id: 'remove',
      label: useSelection ? `Remove ${targets.length} Readings` : 'Remove',
      iconName: 'Trash2',
      destructive: true,
      divider: useSelection ? 'before' : undefined,
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
  }, [profileId, selectedIds, showMenu, openReading, saveOffline, duplicate, setStatus, remove, groupReadings])

  const handleVimCommand = (cmd: VimCommand): void => {
    const at = vimCursor ? vimRows.indexOf(vimCursor) : -1
    const moveTo = (index: number): void => {
      const row = vimRows[Math.max(0, Math.min(vimRows.length - 1, index))]
      if (row) setVimCursorId(row.id)
    }
    // The header a reading row sits under, if it's in a group or the archive.
    const headerOf = (r: Reading): ShelfRow | undefined =>
      r.status === 'archived'
        ? vimRows.find((row) => row.kind === 'archive')
        : vimRows.find((row) => row.kind === 'group' && row.id === r.groupId)
    const setHeaderCollapsed = (header: ShelfRow, collapsed: boolean): void => {
      if (header.kind === 'group') {
        if (header.group.isCollapsed !== collapsed) toggleGroup(header.group)
      } else if (header.kind === 'archive') {
        setArchiveCollapsed(collapsed)
      }
    }
    switch (cmd) {
      case 'down': moveTo(at + 1); break
      case 'up': moveTo(at - 1); break
      case 'top': moveTo(0); break
      case 'bottom': moveTo(vimRows.length - 1); break
      case 'collapse': {
        if (!vimCursor) break
        // On a reading inside a group (or the archive), h climbs to the header and folds it.
        const header = vimCursor.kind === 'reading' ? headerOf(vimCursor.reading) : vimCursor
        if (!header) break
        setHeaderCollapsed(header, true)
        setVimCursorId(header.id)
        break
      }
      case 'expand':
        if (vimCursor && vimCursor.kind !== 'reading') setHeaderCollapsed(vimCursor, false)
        break
      case 'close':
        if (!vimCursor) break
        if (vimCursor.kind === 'reading') {
          // The cursor takes the next row, as vim's x leaves it on what follows.
          const next = vimRows[at + 1] ?? vimRows[at - 1]
          setVimCursorId(next?.id ?? null)
          remove(vimCursor.id)
        } else if (vimCursor.kind === 'group') {
          // Removes the group but keeps its readings — nothing is lost to a stray x.
          ungroup(vimCursor.id)
        }
        break
      case 'menu': {
        if (!vimCursor || vimCursor.kind === 'archive') break
        const row = findVimRow(vimCursor.id)
        if (!row) break
        // Just under the row, past the cursor block and the favicon column.
        const rect = row.getBoundingClientRect()
        const point = { x: rect.left + 24, y: rect.bottom }
        if (vimCursor.kind === 'group') void openGroupMenu(vimCursor.group, point, true)
        else void openReadingMenu(vimCursor.reading, point, true)
        break
      }
      case 'enter':
        if (!vimCursor) break
        if (vimCursor.kind === 'reading') {
          // Leave vim mode first so the new tab takes the keyboard.
          onVimExit(false)
          openReading(vimCursor.reading, false)
        } else {
          // Same as clicking a header: fold or unfold it.
          setHeaderCollapsed(vimCursor, vimCursor.kind === 'group' ? !vimCursor.group.isCollapsed : !archiveCollapsed)
        }
        break
      case 'escape':
        onVimExit(true)
        break
    }
  }

  // ── drag handlers ──
  const computeZone = (y: number): void => {
    const root = listRef.current
    if (!root) return
    let found: string | null = null
    root.querySelectorAll('[data-drop-zone]').forEach((z) => {
      const rect = z.getBoundingClientRect()
      if (y >= rect.top && y <= rect.bottom) found = z.getAttribute('data-drop-zone')
    })
    setDropZone(found)
  }

  const finish = useCallback(() => {
    const id = dragId
    const zone = dropZone
    setDragId(null)
    setDropZone(null)
    if (!id || !zone || !profileId) return
    const target = zone === 'ungrouped' ? null : zone
    const current = readings.find((x) => x.id === id)?.groupId ?? null
    if (current === target) return
    window.electronAPI.bookshelfMoveReading?.(profileId, id, target)
  }, [dragId, dropZone, profileId, readings])
  const finishRef = useRef(finish)
  finishRef.current = finish

  const startDrag = useCallback((id: string, e: React.MouseEvent) => {
    // Modifier-clicks are multi-select, not drags — let them through to onClick.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return
    startPos.current = { x: e.clientX, y: e.clientY }
    activated.current = false
    const onMove = (me: MouseEvent) => {
      if (!startPos.current) return
      const moved = Math.abs(me.clientX - startPos.current.x) + Math.abs(me.clientY - startPos.current.y)
      if (!activated.current && moved < 6) return
      if (!activated.current) { activated.current = true; suppressClick.current = true; setDragId(id) }
      computeZone(me.clientY)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (activated.current) finishRef.current()
      startPos.current = null
      activated.current = false
      // Let the row's click fire first and be swallowed, then re-enable.
      setTimeout(() => { suppressClick.current = false }, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  if (!open) return null

  const ungrouped = readings.filter((r) => r.status === 'toread' && !r.groupId)
  const archived = readings.filter((r) => r.status === 'archived')
  const inGroup = (gid: string) => readings.filter((r) => r.status === 'toread' && r.groupId === gid)
  const isEmpty = readings.length === 0 && groups.length === 0

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
            onCancel={() => { setEditingId(null); setEditValue('') }}
            className="flex-1 min-w-0 bg-input rounded px-1.5 py-0.5 text-xs text-foreground outline-none border border-primary/40"
          />
        </div>
      )
    }
    const selected = selectedIds.has(r.id)
    return (
      <div
        key={r.id}
        data-sidebar-row=""
        data-vim-row={r.id}
        className={`relative flex items-center gap-1 px-1 py-1 cursor-pointer group/row transition-colors ${
          selected ? 'bg-primary/20 text-foreground' : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
        } ${isArchived ? 'opacity-60' : ''} ${dragId === r.id ? 'opacity-30' : ''}`}
        title={r.url}
        onMouseDown={(e) => startDrag(r.id, e)}
        onClick={(e) => handleReadingClick(r, e)}
        onContextMenu={(e) => openReadingMenu(r, contextMenuPoint(e))}
      >
        {vimActive && vimCursor?.id === r.id && <span data-vim-cursor="" aria-hidden />}
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
    const isDrop = dropZone === g.id
    return (
      <div
        key={g.id}
        data-group-container=""
        data-drop-zone={g.id}
        className={`relative transition-colors ${isDrop ? 'ring-1 ring-inset ring-primary/50 bg-primary/5' : ''}`}
        style={{ ['--gc' as string]: g.color }}
      >
        {/* Header mirrors the sidebar tab-group: a colored count badge on the
            leading edge, then an Edge-style colored pill that swallows the
            collapse chevron + name. Colors come from globals.css via --gc. */}
        <div
          data-sidebar-row=""
          data-sidebar-group-row=""
          data-vim-row={g.id}
          {...(!g.isCollapsed && items.length > 0 ? { 'data-group-expanded': '' } : {})}
          className="group/gh relative flex items-center gap-1 px-1 py-1 cursor-pointer hover:bg-accent"
          onClick={() => { if (editingGroupId !== g.id) toggleGroup(g) }}
          onContextMenu={(e) => openGroupMenu(g, contextMenuPoint(e))}
        >
          {vimActive && vimCursor?.id === g.id && <span data-vim-cursor="" aria-hidden />}
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
                onCancel={() => { setEditingGroupId(null); setGroupEditValue('') }}
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
              <div className="px-2 py-1.5 pl-3 text-[10px] text-muted-foreground/60">Drop readings here</div>
            ) : (
              items.map((r) => renderRow(r, false))
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={{ width }}
      className="bg-toolbar border-l border-border flex flex-col shrink-0 overflow-hidden select-none relative"
    >
      <div className="flex items-center gap-1 px-3 h-10 border-b border-border shrink-0">
        <BookOpen size={15} className="text-muted-foreground" />
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
          data-drop-zone="ungrouped"
          className={`transition-colors ${dropZone === 'ungrouped' ? 'ring-1 ring-inset ring-primary/50 bg-primary/5' : ''}`}
          style={{ minHeight: groups.length > 0 ? 12 : undefined }}
        >
          {isEmpty ? (
            <div className="px-2 py-3 text-xs text-muted-foreground/70">
              Nothing here yet. Hit “+” to save the current page; Shift/Ctrl-click readings, then the folder icon to group them.
            </div>
          ) : (
            ungrouped.map((r) => renderRow(r, false))
          )}
        </div>

        {groups.map(renderGroup)}

        {archived.length > 0 && (
          <div className="mt-2">
            <button
              data-vim-row={ARCHIVE_ROW_ID}
              onClick={() => setArchiveCollapsed((v) => !v)}
              className="relative w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-muted-foreground/80 uppercase tracking-wider hover:text-foreground"
            >
              {vimActive && vimCursor?.id === ARCHIVE_ROW_ID && <span data-vim-cursor="" aria-hidden />}
              {archiveCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              Archive · {archived.length}
            </button>
            {!archiveCollapsed && archived.map((r) => renderRow(r, true))}
          </div>
        )}
      </div>

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
