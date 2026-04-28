import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useAppStore, getSidebarOrder } from '../store/app-store'
import { log } from '../lib/log'
import { InputDialog } from './InputDialog'
import { MoveToGroupDialog } from './MoveToGroupDialog'
import { TabFavicon } from './TabFavicon'
import {
  ChevronRight, ChevronDown, Plus, X, FolderPlus, MessageSquareText,
} from 'lucide-react'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'

const isMacOS = navigator.platform.toLowerCase().includes('mac')

/** Format an Electron accelerator string for display in a tooltip / hint.
 *  Shown next to the bottom "New Tab" affordance. */
function formatAccel(accel: string): string {
  if (isMacOS) {
    return accel
      .replace(/CmdOrCtrl\+?/g, '⌘')
      .replace(/Shift\+?/g, '⇧')
      .replace(/Alt\+?/g, '⌥')
      .replace(/Ctrl\+?/g, '⌃')
      .replace(/\+/g, '')
  }
  return accel.replace(/CmdOrCtrl/g, 'Ctrl')
}

// Read the parent's theme attributes so the popup window picks up the same
// theme. The popup is its own BrowserWindow → its CSS variables must be
// re-applied per spec rather than inherited.
function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

interface TabItem {
  id: string
  title: string
  favicon: string
  comment?: string
}

interface GroupItem {
  id: string
  name: string
  color: string
  tabs: TabItem[]
  isCollapsed: boolean
}

const MIN_WIDTH = 180
const DEFAULT_WIDTH = 256
const SIDEBAR_WIDTH_KEY = 'newbro-sidebar-width'

// Group pill text is always dark — matches Edge's behavior across the whole
// palette. The medium-light Edge colors (see GROUP_COLORS in app-store.ts)
// are picked so dark text stays readable regardless of hue, so we don't need
// to flip black/white per color anymore.
const PILL_TEXT_COLOR = '#1a1a1a'
// Horizontal alignment between the pill and the indent guide line that
// hangs below it is owned by globals.css now (`[data-group-children]`
// margin-left tracks the density-aware row padding-left). Nothing in JS
// needs to know the pixel value.

// ── Drop target: where a dragged item will land ──
interface DropTarget {
  // For tabs: which container (null = ungrouped) and position
  // For groups: which position among groups
  type: 'tab' | 'group'
  containerId: string | null  // null = ungrouped, groupId = inside group
  index: number
}

function loadWidth(): number {
  const v = localStorage.getItem(SIDEBAR_WIDTH_KEY)
  return v ? Math.max(MIN_WIDTH, parseInt(v, 10)) : DEFAULT_WIDTH
}

interface Props {
  visible: boolean
}

export function Sidebar({ visible }: Props) {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const profiles = useAppStore((s) => s.profiles)
  const renameTabGroup = useAppStore((s) => s.renameTabGroup)
  const toggleTabGroupCollapse = useAppStore((s) => s.toggleTabGroupCollapse)
  const addTab = useAppStore((s) => s.addTab)
  const addUngroupedTab = useAppStore((s) => s.addUngroupedTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const moveTabs = useAppStore((s) => s.moveTabs)
  const moveTabGroup = useAppStore((s) => s.moveTabGroup)
  const moveTabToGroup = useAppStore((s) => s.moveTabToGroup)
  const moveTabsToNewGroup = useAppStore((s) => s.moveTabsToNewGroup)
  const ungroupTab = useAppStore((s) => s.ungroupTab)
  const ungroupAll = useAppStore((s) => s.ungroupAll)
  const closeGroup = useAppStore((s) => s.closeGroup)
  const setTabComment = useAppStore((s) => s.setTabComment)

  // Current "new tab" keybinding, mirrored from main so the bottom-pinned
  // affordance can show the accelerator the user actually has bound.
  const [newTabAccel, setNewTabAccel] = useState<string>('CmdOrCtrl+T')
  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI
    void api?.loadSettings?.().then((s: any) => {
      if (cancelled) return
      const k = s?.keybindings?.['new-tab']
      if (typeof k === 'string' && k) setNewTabAccel(k)
    })
    const cleanup = api?.onSettingsUpdated?.((s: any) => {
      const k = s?.keybindings?.['new-tab']
      if (typeof k === 'string' && k) setNewTabAccel(k)
    })
    return () => { cancelled = true; cleanup?.() }
  }, [])

  const handleNewTab = useCallback(() => {
    if (activeTabGroupId) addTab(activeTabGroupId)
    else if (activeWorkspaceId) addUngroupedTab(activeWorkspaceId)
  }, [activeTabGroupId, activeWorkspaceId, addTab, addUngroupedTab])

  const workspace = (() => {
    const profile = profiles.find((p) => p.id === activeProfileId)
    return profile?.workspaces.find((w) => w.id === activeWorkspaceId)
  })()

  // ── Resize ──
  const [width, setWidth] = useState(loadWidth)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const currentW = useRef(loadWidth())

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    startX.current = e.clientX
    startW.current = currentW.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    // Tabs are now WebContentsViews layered on top of the renderer; with
    // them visible, pointermove would be eaten by the guest. Tell the
    // WebviewPanel to zero out tab bounds for the duration of the drag.
    window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      const maxW = Math.floor(window.innerWidth / 2)
      const newW = Math.min(maxW, Math.max(MIN_WIDTH, startW.current + (e.clientX - startX.current)))
      currentW.current = newW
      setWidth(newW)
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentW.current))
      window.dispatchEvent(new CustomEvent('newbro-tab-show'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ── Group editing ──
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [selectedTabIds, setSelectedTabIds] = useState<Set<string>>(new Set())
  const lastClickedTabRef = useRef<string | null>(null)
  const [groupFromSelectionOpen, setGroupFromSelectionOpen] = useState(false)
  const [groupFromContextOpen, setGroupFromContextOpen] = useState(false)
  const [contextTabForGroup, setContextTabForGroup] = useState<string | null>(null)
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentTabId, setCommentTabId] = useState<string | null>(null)
  const [commentDefault, setCommentDefault] = useState('')
  // Move-to-group dialog state. We snapshot the candidate groups + the tab's
  // title at right-click time so the dialog is self-contained and doesn't
  // need to recompute as state evolves while it's open.
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [moveDialogTabId, setMoveDialogTabId] = useState<string | null>(null)
  const [moveDialogGroups, setMoveDialogGroups] = useState<{ id: string; name: string; color: string }[]>([])
  const [moveDialogTabTitle, setMoveDialogTabTitle] = useState<string | undefined>(undefined)

  // ── Drag & Drop (pointer-based, no library) ──
  const [dragging, setDragging] = useState<{ type: 'tab' | 'group'; id: string; ids: string[] } | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const dragActivated = useRef(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // ── Drag handlers ──
  const startDrag = useCallback((type: 'tab' | 'group', id: string, ids: string[], e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    dragActivated.current = false

    const onMove = (me: MouseEvent) => {
      if (!dragStartPos.current) return
      const dx = me.clientX - dragStartPos.current.x
      const dy = me.clientY - dragStartPos.current.y
      if (!dragActivated.current && Math.abs(dx) + Math.abs(dy) < 6) return
      dragActivated.current = true
      setDragging({ type, id, ids })
      window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
      // Determine drop target from pointer position
      updateDropTarget(me.clientY, type)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (dragActivated.current) {
        // Perform the drop
        finishDrag()
      }
      dragStartPos.current = null
      dragActivated.current = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Convert DOM container attribute back to store value
  const containerFromAttr = (attr: string | null): string | null => {
    if (!attr || attr === '__ungrouped__') return null
    return attr
  }

  // Build drop target from pointer Y position by scanning DOM elements
  const updateDropTarget = useCallback((pointerY: number, dragType: 'tab' | 'group') => {
    const sidebar = sidebarRef.current
    if (!sidebar) return

    if (dragType === 'tab') {
      const rows = sidebar.querySelectorAll('[data-drop-tab-id], [data-drop-group-header]')
      let best: DropTarget | null = null
      let bestDist = Infinity

      rows.forEach((row) => {
        const rect = row.getBoundingClientRect()

        if (row.hasAttribute('data-drop-tab-id')) {
          const containerId = containerFromAttr(row.getAttribute('data-drop-container'))
          const index = parseInt(row.getAttribute('data-drop-index') || '0', 10)
          const midY = rect.top + rect.height / 2

          if (pointerY < midY) {
            const dist = Math.abs(pointerY - rect.top)
            if (dist < bestDist) { bestDist = dist; best = { type: 'tab', containerId, index } }
          } else {
            const dist = Math.abs(pointerY - rect.bottom)
            if (dist < bestDist) { bestDist = dist; best = { type: 'tab', containerId, index: index + 1 } }
          }
        } else if (row.hasAttribute('data-drop-group-header')) {
          const groupId = row.getAttribute('data-drop-group-header')!
          const sidebarIdx = parseInt(row.getAttribute('data-sidebar-index') || '0', 10)
          const height = rect.height
          const topEdge = rect.top + height * 0.25
          const bottomEdge = rect.bottom - height * 0.25

          if (pointerY < topEdge) {
            // Top zone: drop as ungrouped before this group
            const dist = Math.abs(pointerY - rect.top)
            if (dist < bestDist) { bestDist = dist; best = { type: 'tab', containerId: null, index: sidebarIdx } }
          } else if (pointerY > bottomEdge) {
            // Bottom zone: drop as ungrouped after this group
            const dist = Math.abs(pointerY - rect.bottom)
            if (dist < bestDist) { bestDist = dist; best = { type: 'tab', containerId: null, index: sidebarIdx + 1 } }
          } else {
            // Center zone: drop into the group
            bestDist = 0
            best = { type: 'tab', containerId: groupId, index: 0 }
          }
        }
      })

      if (!best) {
        const orderLength = workspace ? getSidebarOrder(workspace).length : 0
        best = { type: 'tab', containerId: null, index: orderLength }
      }
      setDropTarget(best)

    } else if (dragType === 'group') {
      // For group reordering, use all top-level sidebar blocks
      const blocks = sidebar.querySelectorAll('[data-sidebar-block]')
      let best: DropTarget | null = null
      let bestDist = Infinity

      blocks.forEach((block) => {
        const rect = block.getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        const sidebarIdx = parseInt(block.getAttribute('data-sidebar-block') || '0', 10)

        if (pointerY < midY) {
          const dist = Math.abs(pointerY - midY)
          if (dist < bestDist) { bestDist = dist; best = { type: 'group', containerId: null, index: sidebarIdx } }
        } else {
          const dist = Math.abs(pointerY - midY)
          if (dist < bestDist) { bestDist = dist; best = { type: 'group', containerId: null, index: sidebarIdx + 1 } }
        }
      })

      if (!best && workspace) {
        best = { type: 'group', containerId: null, index: getSidebarOrder(workspace).length }
      }
      setDropTarget(best)
    }
  }, [workspace])

  // Effect to continuously track pointer during drag
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      updateDropTarget(e.clientY, dragging.type)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [dragging, updateDropTarget])

  const finishDrag = useCallback(() => {
    const d = dragging
    const dt = dropTarget
    // Clean up immediately
    setDragging(null)
    setDropTarget(null)
    window.dispatchEvent(new CustomEvent('newbro-tab-show'))

    if (!d || !dt) return

    if (d.type === 'tab' && dt.type === 'tab') {
      moveTabs(d.ids, dt.containerId, dt.index)
      setSelectedTabIds(new Set())
    } else if (d.type === 'group' && dt.type === 'group') {
      moveTabGroup(d.id, dt.index)
    }
  }, [dragging, dropTarget, moveTabs, moveTabGroup])

  // Expose finishDrag as ref so the mouseup handler can access latest state
  const finishDragRef = useRef(finishDrag)
  finishDragRef.current = finishDrag

  // Override the startDrag's finishDrag reference
  const startDragStable = useCallback((type: 'tab' | 'group', id: string, ids: string[], e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    dragActivated.current = false

    const onMove = (me: MouseEvent) => {
      if (!dragStartPos.current) return
      const dx = me.clientX - dragStartPos.current.x
      const dy = me.clientY - dragStartPos.current.y
      if (!dragActivated.current && Math.abs(dx) + Math.abs(dy) < 6) return

      if (!dragActivated.current) {
        dragActivated.current = true
        setDragging({ type, id, ids })
        window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
      }
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (dragActivated.current) {
        finishDragRef.current()
      }
      dragStartPos.current = null
      dragActivated.current = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ── Sidebar items from sidebarOrder ──
  const sidebarItems = useMemo(() => {
    if (!workspace) return []
    const order = getSidebarOrder(workspace)
    const tabMap = new Map((workspace.tabs || []).map((t) => [t.id, t]))
    const groupMap = new Map(workspace.tabGroups.map((g) => [g.id, g]))
    return order
      .map((id) => {
        const tab = tabMap.get(id)
        if (tab) return { type: 'tab' as const, id, tab }
        const group = groupMap.get(id)
        if (group) return { type: 'group' as const, id, group }
        return null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
  }, [workspace])

  // ── Tab click handlers ──
  const allTabIds: string[] = []
  for (const item of sidebarItems) {
    if (item.type === 'tab') allTabIds.push(item.id)
    else for (const t of item.group.tabs) allTabIds.push(t.id)
  }

  const handleTabClick = (tabId: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedTabIds((prev) => {
        const next = new Set(prev)
        if (next.has(tabId)) next.delete(tabId)
        else next.add(tabId)
        return next
      })
      lastClickedTabRef.current = tabId
      return
    }

    if (e.shiftKey && lastClickedTabRef.current) {
      const s = allTabIds.indexOf(lastClickedTabRef.current)
      const end = allTabIds.indexOf(tabId)
      if (s !== -1 && end !== -1) {
        setSelectedTabIds(new Set(allTabIds.slice(Math.min(s, end), Math.max(s, end) + 1)))
      }
      return
    }

    setSelectedTabIds(new Set())
    setActiveTab(tabId)
    lastClickedTabRef.current = tabId
  }

  const handleGroupDoubleClick = (id: string, name: string) => {
    setEditingGroupId(id)
    setEditValue(name)
  }

  const commitGroupRename = (id: string) => {
    if (editValue.trim()) renameTabGroup(id, editValue.trim())
    setEditingGroupId(null)
  }

  const handleTabContextMenu = async (tabId: string, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const tabGroupId = findTabGroup(tabId)
    const isUngrouped = tabGroupId === null
    const tab = workspace.tabs?.find((t) => t.id === tabId)
      || workspace.tabGroups.flatMap((g) => g.tabs).find((t) => t.id === tabId)
    const hasComment = !!tab?.comment
    const closeShortcut = [isMacOS ? '⌘' : 'Ctrl', 'W']

    // Header shows the tab's title (truncated by the popup) so the user has
    // visual confirmation of WHICH tab they're acting on — useful when the
    // sidebar is dense and right-click hit-targets are small.
    const header = tab?.title?.trim() || (() => {
      try { return new URL(tab?.url ?? '').host } catch { return undefined }
    })()

    const actions: DropdownAction[] = [
      { id: 'close', label: 'Close Tab', iconName: 'X', shortcut: closeShortcut },
    ]
    if (!isUngrouped) {
      actions.push({ id: 'ungroup', label: 'Ungroup Tab', iconName: 'FolderMinus' })
    }
    actions.push({ id: 'new-group', label: 'Add to New Group…', iconName: 'FolderPlus' })
    actions.push({
      id: 'set-comment',
      label: hasComment ? 'Edit Comment…' : 'Set Comment…',
      iconName: 'MessageSquare',
      divider: 'before',
    })
    if (hasComment) {
      actions.push({ id: 'remove-comment', label: 'Remove Comment', iconName: 'MessageSquareOff' })
    }
    const otherGroups = workspace.tabGroups.filter((g) => g.id !== tabGroupId)
    if (otherGroups.length > 0) {
      actions.push({
        id: 'move-to-group',
        label: 'Move to Group…',
        iconName: 'FolderInput',
        divider: 'before',
      })
    }

    const result = await openDropdownAsync({
      kind: 'menu',
      position: { x: e.clientX, y: e.clientY },
      ...readThemeAttrs(),
      header,
      actions,
    })
    if (!result || result.type !== 'action') return
    const action = result.actionId
    if (action === 'close') closeTab(tabId)
    else if (action === 'ungroup') ungroupTab(tabId)
    else if (action === 'new-group') { setContextTabForGroup(tabId); setGroupFromContextOpen(true) }
    else if (action === 'set-comment') { setCommentTabId(tabId); setCommentDefault(tab?.comment || ''); setCommentDialogOpen(true) }
    else if (action === 'remove-comment') setTabComment(tabId, '')
    else if (action === 'move-to-group') {
      // Hand off to a real modal dialog (own BrowserWindow) so the picker has
      // its own search field, scrollable list, and lifecycle independent of
      // the context-menu popup. Snapshot the group list and tab title at
      // open time — the dialog reads from these props, not live store state.
      setMoveDialogTabId(tabId)
      setMoveDialogGroups(otherGroups.map((g) => ({ id: g.id, name: g.name, color: g.color })))
      setMoveDialogTabTitle(tab?.title)
      setMoveDialogOpen(true)
    }
  }

  const handleGroupContextMenu = async (groupId: string, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const group = workspace.tabGroups.find((g) => g.id === groupId)
    if (!group) return

    const tabCount = group.tabs.length
    const actions: DropdownAction[] = [
      { id: 'rename', label: 'Rename Group', iconName: 'Pencil' },
      { id: 'add-tab', label: 'Add Tab to Group', iconName: 'FilePlus' },
      { id: 'ungroup-all', label: 'Ungroup All Tabs', iconName: 'FolderMinus', divider: 'before' },
      {
        id: 'close-group',
        label: `Close Group (${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'})`,
        iconName: 'X',
        destructive: true,
      },
    ]

    const result = await openDropdownAsync({
      kind: 'menu',
      position: { x: e.clientX, y: e.clientY },
      ...readThemeAttrs(),
      header: group.name,
      actions,
    })
    if (!result || result.type !== 'action') return
    const action = result.actionId
    if (action === 'rename') handleGroupDoubleClick(groupId, group.name)
    else if (action === 'add-tab') addTab(groupId)
    else if (action === 'ungroup-all') ungroupAll(groupId)
    else if (action === 'close-group') closeGroup(groupId)
  }

  const findTabGroup = (tabId: string): string | null => {
    if (!workspace) return null
    for (const g of workspace.tabGroups) {
      if (g.tabs.some((t) => t.id === tabId)) return g.id
    }
    return null
  }

  const getOrderedDraggedTabIds = (ids: string[]): string[] => {
    const idSet = new Set(ids)
    const ordered: string[] = []
    for (const item of sidebarItems) {
      if (item.type === 'tab' && idSet.has(item.id)) ordered.push(item.id)
      else if (item.type === 'group') {
        for (const t of item.group.tabs) if (idSet.has(t.id)) ordered.push(t.id)
      }
    }
    return ordered.length > 0 ? ordered : ids
  }

  // ── Drop indicator helpers ──
  // For ungrouped tabs and sidebar-level drops (between top-level items)
  const isSidebarDropBefore = (sidebarIdx: number): boolean => {
    if (!dropTarget || !dragging) return false
    if (dropTarget.containerId !== null) return false
    return dropTarget.index === sidebarIdx
  }

  // For tabs within a group
  const isGroupedTabDropBefore = (groupId: string, tabIdx: number): boolean => {
    if (!dropTarget || !dragging || dragging.type !== 'tab') return false
    return dropTarget.containerId === groupId && dropTarget.index === tabIdx
  }

  // ── Rendering ──
  if (!visible) return null

  if (!workspace) {
    return (
      <div style={{ width }} className="bg-card border-r border-border flex items-center justify-center text-muted-foreground text-sm shrink-0">
        No workspace
      </div>
    )
  }

  const hasSelection = selectedTabIds.size > 0
  const isDraggingTab = dragging?.type === 'tab'
  const isDraggingGroup = dragging?.type === 'group'

  const renderTabRow = (tab: TabItem, containerId: string | null, index: number) => {
    const isBeingDragged = dragging?.ids.includes(tab.id) ?? false
    const selected = selectedTabIds.has(tab.id)
    const active = tab.id === activeTabId
    const showBefore = containerId === null
      ? isSidebarDropBefore(index)
      : isGroupedTabDropBefore(containerId, index)
    const containerAttr = containerId ?? '__ungrouped__'

    return (
      <div
        key={tab.id}
        data-sidebar-row=""
        data-drop-tab-id={tab.id}
        data-drop-container={containerAttr}
        data-drop-index={index}
        {...(containerId === null ? { 'data-sidebar-block': index } : {})}
        className={`relative flex items-center gap-1 px-1 py-1 cursor-pointer group/tab transition-colors ${
          selected ? 'bg-primary/20 text-foreground'
          : active ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
        } ${isBeingDragged ? 'opacity-30' : ''}`}
        onClick={(e) => handleTabClick(tab.id, e)}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          const ids = selectedTabIds.has(tab.id) && selectedTabIds.size > 1
            ? getOrderedDraggedTabIds([...selectedTabIds])
            : [tab.id]
          startDragStable('tab', tab.id, ids, e)
        }}
        onContextMenu={(e) => handleTabContextMenu(tab.id, e)}
      >
        {showBefore && (
          <div className="absolute left-1 right-1 -top-px h-[3px] bg-primary rounded-full z-10" />
        )}
        <TabFavicon favicon={tab.favicon} />
        {tab.comment && <MessageSquareText size={16} className="shrink-0 text-primary/60" />}
        <span className="flex-1 text-xs truncate">{tab.comment ? `${tab.comment} — ${tab.title}` : tab.title}</span>
        {/* Close button: same overlay treatment as the group action buttons.
            Floated above the row on the right so the title can use the
            full row width without reserving a permanent 24px slot for
            the X. Hover-only for every tab — active included — so the
            row's right edge stays clean until the user actually mouses
            over it. */}
        <div
          className="absolute right-1 top-0 bottom-0 flex items-center transition-opacity opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto"
        >
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.id)
            }}
            className="h-6 w-6 flex items-center justify-center rounded bg-card/85 backdrop-blur-sm hover:bg-destructive/20 text-muted-foreground hover:text-destructive pointer-events-auto"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  const renderGroupHeader = (group: GroupItem, sidebarIdx: number) => {
    const isEditing = editingGroupId === group.id
    const isBeingDragged = dragging?.type === 'group' && dragging.id === group.id
    const showGroupBefore = isSidebarDropBefore(sidebarIdx)
    // "Drop into" highlight: when dragging a tab and the drop target is this group
    const isDropIntoTarget = isDraggingTab && dropTarget?.containerId === group.id

    return (
      <div
        data-sidebar-row=""
        data-sidebar-group-row=""
        data-drop-group-header={group.id}
        data-sidebar-index={sidebarIdx}
        className={`relative flex items-center gap-1 px-1 py-1 cursor-pointer group ${
          isBeingDragged ? 'opacity-30' : ''
        } ${
          // During tab drag: suppress normal hover, show "drop into" highlight instead
          isDraggingTab
            ? isDropIntoTarget
              ? 'bg-primary/30 ring-1 ring-inset ring-primary/40'
              : ''
            : 'hover:bg-accent'
        }`}
        onMouseDown={(e) => {
          if (e.button !== 0 || isEditing) return
          startDragStable('group', group.id, [group.id], e)
        }}
        onClick={() => {
          if (isEditing) return
          toggleTabGroupCollapse(group.id)
        }}
        onContextMenu={(e) => handleGroupContextMenu(group.id, e)}
      >
        {showGroupBefore && (
          <div className="absolute left-1 right-1 -top-px h-[3px] bg-primary rounded-full z-10" />
        )}
        {/* Edge-style colored pill. SWALLOWS the chevron, content-sized
            via inline-flex (no flex-1), with `max-w-full` letting it grow
            up to the row's right edge for long names — at which point
            the inner name truncates. Action buttons are floated above
            the pill (see absolute overlay below) so the pill always has
            the full row to use; we don't have to leave a fixed gap on
            the right for them. */}
        <span
          data-group-pill=""
          style={{ backgroundColor: group.color, color: PILL_TEXT_COLOR }}
          className="inline-flex items-center gap-1 max-w-full pl-1.5 pr-3 py-1 rounded-md text-xs font-medium overflow-hidden"
        >
          <span className="shrink-0 inline-flex items-center">
            {group.isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
          {isEditing ? (
            <input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => commitGroupRename(group.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGroupRename(group.id)
                if (e.key === 'Escape') setEditingGroupId(null)
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              style={{ color: PILL_TEXT_COLOR }}
              className="flex-1 min-w-0 bg-transparent outline-none placeholder:opacity-60"
              autoFocus
            />
          ) : (
            <span className="flex-1 min-w-0 truncate">{group.name}</span>
          )}
        </span>
        {/* Action overlay — absolute right, sits ON TOP of the pill on
            hover so the pill underneath isn't squeezed by reserved button
            space. Each button has a card-tone background so the icons
            stay readable when they hover over the colored pill text. */}
        <div className="absolute right-1 top-0 bottom-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
          <span
            className="text-[10px] text-muted-foreground bg-card/85 backdrop-blur-sm rounded px-1"
            title={`${group.tabs.length} tabs`}
          >
            {group.tabs.length}
          </span>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              addTab(group.id)
            }}
            className="h-6 w-6 items-center justify-center rounded bg-card/85 backdrop-blur-sm hover:bg-muted text-muted-foreground hover:text-foreground flex"
            title="Add tab"
          >
            <Plus size={14} />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              closeGroup(group.id)
            }}
            className="h-6 w-6 items-center justify-center rounded bg-card/85 backdrop-blur-sm hover:bg-destructive/20 text-muted-foreground hover:text-destructive flex"
            title="Close group"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  // Show "after last tab in group" indicator
  const showAfterLastInGroup = (groupId: string, tabCount: number) =>
    isDraggingTab && dropTarget?.containerId === groupId && dropTarget?.index === tabCount && tabCount > 0

  // Show "after last sidebar item" indicator
  const showAfterLastSidebarItem = (dragging?.type === 'tab' || dragging?.type === 'group') &&
    dropTarget?.containerId === null && dropTarget?.index === sidebarItems.length && sidebarItems.length > 0

  return (
    <>
      <div ref={sidebarRef} style={{ width }} className="bg-toolbar border-r border-border flex flex-col shrink-0 overflow-hidden select-none relative">
        {hasSelection && (
          <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border bg-accent/30">
            <span className="text-[10px] text-muted-foreground flex-1">{selectedTabIds.size} selected</span>
            <button
              onClick={() => setGroupFromSelectionOpen(true)}
              className="h-6 px-2 flex items-center gap-1 rounded text-[10px] font-medium bg-primary text-primary-foreground hover:opacity-90"
              title="Move to new group"
            >
              <FolderPlus size={14} /> Group
            </button>
            <button
              onClick={() => setSelectedTabIds(new Set())}
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto pt-0 pb-0.5">
          {sidebarItems.map((item, sidebarIdx) => {
            if (item.type === 'tab') {
              return renderTabRow(item.tab, null, sidebarIdx)
            }
            const group = item.group
            return (
              <div key={item.id} className="mb-0 relative" data-sidebar-block={sidebarIdx}>
                {renderGroupHeader(group as GroupItem, sidebarIdx)}

                {!group.isCollapsed && (
                  // Edge-style indent guide: 2px colored line dropping out
                  // of the bottom of the pill. Horizontal positioning is
                  // owned by the `[data-group-children]` CSS rule in
                  // globals.css, which keeps the line's left edge in sync
                  // with the row's density-aware padding-left so the line
                  // stays continuous with the pill above in both compact
                  // and normal modes.
                  <div
                    data-group-children=""
                    className="border-l-2"
                    style={{ borderColor: group.color }}
                  >
                    {group.tabs.map((tab, tabIndex) => renderTabRow(tab, group.id, tabIndex))}
                    {showAfterLastInGroup(group.id, group.tabs.length) && (
                      <div className="relative h-0">
                        <div className="absolute left-1 right-1 -top-px h-[3px] bg-primary rounded-full z-10" />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* "After last item" indicator */}
          {showAfterLastSidebarItem && (
            <div className="relative h-0">
              <div className="absolute left-1 right-1 -top-px h-[3px] bg-primary rounded-full z-10" />
            </div>
          )}

          {/* Empty sidebar drop target */}
          {dragging && dropTarget?.containerId === null && sidebarItems.length === 0 && (
            <div className="relative h-0">
              <div className="absolute left-1 right-1 top-0 h-[3px] bg-primary rounded-full z-10" />
            </div>
          )}

          {/* "New Tab" row — rendered inside the scroll area as the
              always-last item, so it sits right under the user's last
              tab/group and floats up to the top when the workspace has no
              tabs yet. Tooltip + inline accelerator surface the user's
              bound shortcut. */}
          <button
            type="button"
            onClick={handleNewTab}
            title={`New Tab (${formatAccel(newTabAccel)})`}
            className="w-full flex items-center gap-1 px-1 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <Plus size={16} className="shrink-0" />
            <span className="flex-1 text-left text-xs truncate">New Tab</span>
            <span className="text-[10px] text-muted-foreground/70 font-mono shrink-0 pr-1">
              {formatAccel(newTabAccel)}
            </span>
          </button>
        </div>

        <div
          className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
          onMouseDown={onResizeStart}
        />
      </div>


      <InputDialog
        open={groupFromSelectionOpen}
        title={`Group ${selectedTabIds.size} tabs`}
        placeholder="Group name"
        onConfirm={(name) => {
          moveTabsToNewGroup([...selectedTabIds], name)
          setSelectedTabIds(new Set())
          setGroupFromSelectionOpen(false)
        }}
        onCancel={() => setGroupFromSelectionOpen(false)}
      />

      <InputDialog
        open={groupFromContextOpen}
        title="New Group"
        placeholder="Group name"
        onConfirm={(name) => {
          if (contextTabForGroup) moveTabsToNewGroup([contextTabForGroup], name)
          setContextTabForGroup(null)
          setGroupFromContextOpen(false)
        }}
        onCancel={() => {
          setContextTabForGroup(null)
          setGroupFromContextOpen(false)
        }}
      />

      <InputDialog
        open={commentDialogOpen}
        title="Tab Comment"
        placeholder="Enter comment..."
        defaultValue={commentDefault}
        confirmLabel="Save"
        onConfirm={(value) => {
          if (commentTabId) setTabComment(commentTabId, value)
          setCommentTabId(null)
          setCommentDialogOpen(false)
        }}
        onCancel={() => {
          setCommentTabId(null)
          setCommentDialogOpen(false)
        }}
      />

      <MoveToGroupDialog
        open={moveDialogOpen}
        tabTitle={moveDialogTabTitle}
        groups={moveDialogGroups}
        onConfirm={(groupId) => {
          if (moveDialogTabId) moveTabToGroup(moveDialogTabId, groupId)
          setMoveDialogOpen(false)
          setMoveDialogTabId(null)
        }}
        onCancel={() => {
          setMoveDialogOpen(false)
          setMoveDialogTabId(null)
        }}
      />
    </>
  )
}
