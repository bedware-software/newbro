import { Fragment, useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useAppStore, getSidebarOrder } from '../store/app-store'
import { log } from '../lib/log'
import { InlineRenameInput } from './InlineRenameInput'
import { InputDialog } from './InputDialog'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'
import { ChevronRight, ChevronDown, Plus, X } from 'lucide-react'
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

// Pill text colour, the guide-line geometry, and the per-theme group
// colour resolution are all owned by globals.css now (see the
// `[data-group-*]` rules there). Nothing in JS needs the pixel value
// or hex literal.

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
  /** When true, the first 9 visible tabs show a small "N" badge advertising
   *  the CmdOrCtrl+N quick-jump. Visible state is owned by App.tsx because
   *  it lives in the settings store. */
  showTabNumbers: boolean
}

export function Sidebar({ visible, showTabNumbers }: Props) {
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
  const moveTabsToNewGroup = useAppStore((s) => s.moveTabsToNewGroup)
  const ungroupTab = useAppStore((s) => s.ungroupTab)
  const ungroupAll = useAppStore((s) => s.ungroupAll)
  const closeGroup = useAppStore((s) => s.closeGroup)
  const setTabComment = useAppStore((s) => s.setTabComment)

  // Current "new tab" keybinding, mirrored from main so the bottom-pinned
  // affordance can show the accelerator the user actually has bound. Each
  // action carries up to two bindings — the affordance has room for one
  // hint, so we surface the first slot.
  const [newTabAccel, setNewTabAccel] = useState<string>('CmdOrCtrl+T')
  useEffect(() => {
    let cancelled = false
    const api = (window as any).electronAPI
    const pickFirst = (raw: unknown): string | null => {
      if (typeof raw === 'string' && raw) return raw
      if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0]) return raw[0]
      return null
    }
    void api?.loadSettings?.().then((s: any) => {
      if (cancelled) return
      const k = pickFirst(s?.keybindings?.['new-tab'])
      if (k) setNewTabAccel(k)
    })
    const cleanup = api?.onSettingsUpdated?.((s: any) => {
      const k = pickFirst(s?.keybindings?.['new-tab'])
      if (k) setNewTabAccel(k)
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
  const [groupFromContextOpen, setGroupFromContextOpen] = useState(false)
  // Tab ids feeding the "New Group…" prompt. Populated from the multi-
  // selection when the right-clicked tab is part of it; otherwise just
  // the right-clicked tab alone.
  const [pendingGroupTabIds, setPendingGroupTabIds] = useState<string[]>([])
  const [commentDialogOpen, setCommentDialogOpen] = useState(false)
  const [commentTabId, setCommentTabId] = useState<string | null>(null)
  const [commentDefault, setCommentDefault] = useState('')

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

  // Visible-order positions (1..9) for the quick-jump badges. Mirrors
  // App.tsx's CmdOrCtrl+N handler: ungrouped tabs and the children of
  // expanded groups, in sidebar order, skipping collapsed groups. Beyond
  // the 9th visible tab no badge is shown — the shortcut only covers 1-9.
  const tabNumberById = useMemo(() => {
    const m = new Map<string, number>()
    if (!showTabNumbers) return m
    let count = 0
    for (const item of sidebarItems) {
      if (item.type === 'tab') {
        if (++count > 9) break
        m.set(item.id, count)
      } else if (!item.group.isCollapsed) {
        for (const t of item.group.tabs) {
          if (++count > 9) break
          m.set(t.id, count)
        }
        if (count > 9) break
      }
    }
    return m
  }, [sidebarItems, showTabNumbers])

  const handleTabClick = (tabId: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setSelectedTabIds((prev) => {
        const next = new Set(prev)
        // First Cmd/Ctrl+Click bootstraps the multi-selection with the
        // active tab. Without this, "New Group from Selection" (and any
        // other action that targets selectedTabIds) silently drops the
        // active tab — Shift+Click already gets this right because
        // lastClickedTabRef.current points at the active tab after a
        // regular click. Skip the seed when the user is Cmd-clicking
        // the active tab itself (otherwise toggling it would never
        // remove it).
        if (prev.size === 0 && activeTabId != null && activeTabId !== tabId) {
          next.add(activeTabId)
        }
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
    if (!workspace) return
    const tabGroupId = findTabGroup(tabId)
    const isUngrouped = tabGroupId === null
    const tab = workspace.tabs?.find((t) => t.id === tabId)
      || workspace.tabGroups.flatMap((g) => g.tabs).find((t) => t.id === tabId)
    const hasComment = !!tab?.comment
    const closeShortcut = [isMacOS ? '⌘' : 'Ctrl', 'W']
    // Snapshot the multi-selection at the moment of right-click so the
    // menu labels and the eventual target list match what the user saw
    // when they opened the menu, regardless of any state changes that
    // happen while the async dropdown is open. The "act on the whole
    // selection" path only kicks in when the right-clicked tab IS in
    // the selection — right-clicking outside is treated as a focused
    // action on that one tab. The same target list feeds close, move,
    // copy, and new-group so all four feel consistent.
    const useSelection = selectedTabIds.has(tabId) && selectedTabIds.size > 1
    const actionTargets = useSelection ? [...selectedTabIds] : [tabId]
    const targetCount = actionTargets.length

    // Header shows the tab's title (truncated by the popup) so the user has
    // visual confirmation of WHICH tab they're acting on — useful when the
    // sidebar is dense and right-click hit-targets are small.
    const header = tab?.title?.trim() || (() => {
      try { return new URL(tab?.url ?? '').host } catch { return undefined }
    })()

    const actions: DropdownAction[] = [
      {
        id: 'close',
        label: useSelection ? `Close ${targetCount} Tabs` : 'Close Tab',
        iconName: 'X',
        // Cmd/Ctrl+W only closes the active tab, so the shortcut hint
        // is only accurate in the single-target case. Suppress it for
        // multi-select to avoid misleading the user.
        ...(useSelection ? {} : { shortcut: closeShortcut }),
      },
    ]
    if (!isUngrouped) {
      actions.push({ id: 'ungroup', label: 'Ungroup Tab', iconName: 'FolderMinus' })
    }
    actions.push({
      id: 'new-group',
      label: useSelection
        ? `Add ${targetCount} Tabs to New Group…`
        : 'Add to New Group…',
      iconName: 'FolderPlus',
    })
    actions.push({
      id: 'set-comment',
      label: hasComment ? 'Edit Comment…' : 'Set Comment…',
      iconName: 'MessageSquare',
      divider: 'before',
    })
    if (hasComment) {
      actions.push({ id: 'remove-comment', label: 'Remove Comment', iconName: 'MessageSquareOff' })
    }
    actions.push({
      id: 'move-tab',
      label: useSelection ? `Move ${targetCount} Tabs…` : 'Move Tab…',
      iconName: 'FolderInput',
      divider: 'before',
    })
    actions.push({
      id: 'copy-tab',
      label: useSelection ? `Copy ${targetCount} Tabs…` : 'Copy Tab…',
      iconName: 'Copy',
    })

    const result = await openDropdownAsync({
      kind: 'menu',
      position: { x: e.clientX, y: e.clientY },
      ...readThemeAttrs(),
      header,
      actions,
    })
    if (!result || result.type !== 'action') return
    const action = result.actionId
    if (action === 'close') {
      for (const id of actionTargets) closeTab(id)
      if (useSelection) setSelectedTabIds(new Set())
    }
    else if (action === 'ungroup') ungroupTab(tabId)
    else if (action === 'new-group') {
      setPendingGroupTabIds(actionTargets)
      setGroupFromContextOpen(true)
    }
    else if (action === 'set-comment') { setCommentTabId(tabId); setCommentDefault(tab?.comment || ''); setCommentDialogOpen(true) }
    else if (action === 'remove-comment') setTabComment(tabId, '')
    else if (action === 'move-tab' || action === 'copy-tab') {
      // App owns the picker dialog state. We forward the resolved target
      // list via a CustomEvent so App can open the dialog targeting these
      // tabs — the keyboard shortcut path always targets the active tab,
      // but context menu lets the user act on any tab or the whole
      // multi-selection.
      window.dispatchEvent(
        new CustomEvent('newbro:open-move-copy-tab', {
          detail: { mode: action === 'move-tab' ? 'move' : 'copy', tabIds: actionTargets },
        }),
      )
      if (useSelection) setSelectedTabIds(new Set())
    }
  }

  const handleGroupContextMenu = async (groupId: string, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    if (!workspace) return
    const group = workspace.tabGroups.find((g) => g.id === groupId)
    if (!group) return

    const tabCount = group.tabs.length
    const actions: DropdownAction[] = [
      { id: 'rename', label: 'Rename Group', iconName: 'Pencil' },
      { id: 'add-tab', label: 'Add Tab to Group', iconName: 'FilePlus' },
      { id: 'move-group', label: 'Move Group…', iconName: 'FolderInput', divider: 'before' },
      { id: 'copy-group', label: 'Copy Group…', iconName: 'Copy' },
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
    else if (action === 'move-group' || action === 'copy-group') {
      window.dispatchEvent(
        new CustomEvent('newbro:open-move-copy-group', {
          detail: { mode: action === 'move-group' ? 'move' : 'copy', groupId },
        }),
      )
    }
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

  const isDraggingTab = dragging?.type === 'tab'
  const isDraggingGroup = dragging?.type === 'group'

  const renderTabRow = (tab: TabItem, containerId: string | null, index: number) => {
    const isBeingDragged = dragging?.ids.includes(tab.id) ?? false
    const selected = selectedTabIds.has(tab.id)
    const active = tab.id === activeTabId
    const tabNumber = tabNumberById.get(tab.id)
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
        {tab.comment && <CommentChip comment={tab.comment} />}
        <span className="min-w-0 flex-1 truncate text-xs" title={tab.title}>{tab.title}</span>
        {/* Right-edge slot: the always-visible Cmd+N badge (when this tab
            is among the first 9 visible) and the hover-only close X share
            a single 24×24 cell. The Cmd+N badge is sized to match the
            group counter on the left (w-4 h-4) and centred inside the
            cell; the close X keeps the full 24×24 click target so it
            stays easy to hit. */}
        <div className="absolute right-1 top-0 bottom-0 flex items-center">
          <div className="relative h-6 w-6 flex items-center justify-center">
            {tabNumber !== undefined && (
              <span
                className="w-4 h-4 inline-flex items-center justify-center rounded bg-card/85 backdrop-blur-sm text-[10px] font-medium tabular-nums text-muted-foreground group-hover/tab:opacity-0 transition-opacity pointer-events-none"
                title={`Switch to this tab — ${isMacOS ? '⌘' : 'Ctrl+'}${tabNumber}`}
              >
                {tabNumber}
              </span>
            )}
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="absolute inset-0 flex items-center justify-center rounded bg-card/85 backdrop-blur-sm hover:bg-destructive/20 text-muted-foreground hover:text-destructive opacity-0 group-hover/tab:opacity-100 pointer-events-none group-hover/tab:pointer-events-auto transition-opacity"
            >
              <X size={14} />
            </button>
          </div>
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
    // When the group is expanded with children, the group-header row carries
    // the bottom half of the guide line that drops from the badge centre
    // down into the nested rows. Skipped for collapsed or empty groups —
    // there's nothing below to connect to. Read by the [data-group-expanded]
    // ::after rule in globals.css.
    const expanded = !group.isCollapsed && group.tabs.length > 0
    // Collapsed group containing the active tab gets the same accent
    // highlight as an active tab row, so the user can still see where
    // their current tab lives when its row isn't visible. When the
    // group is expanded the active tab is already shown directly —
    // highlighting the header on top would be redundant noise.
    const containsActive = group.isCollapsed
      && activeTabId != null
      && group.tabs.some((t) => t.id === activeTabId)

    return (
      <div
        data-sidebar-row=""
        data-sidebar-group-row=""
        data-drop-group-header={group.id}
        data-sidebar-index={sidebarIdx}
        {...(expanded ? { 'data-group-expanded': '' } : {})}
        className={`relative flex items-center gap-1 px-1 py-1 cursor-pointer group ${
          isBeingDragged ? 'opacity-30' : ''
        } ${
          // During tab drag: "drop into" highlight wins over both the active
          // and hover states; otherwise active-containing groups stay lit and
          // the rest get the standard hover treatment.
          isDraggingTab
            ? isDropIntoTarget
              ? 'bg-primary/30 ring-1 ring-inset ring-primary/40'
              : ''
            : containsActive
              ? 'bg-accent text-accent-foreground'
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
        {/* Count badge — leading-edge column. Sized to match a tab row's
            favicon (w-4 h-4) so the leftmost glyph in every sidebar row
            sits on the same vertical axis. Colored with the group's hue
            so it visually pairs with the pill that follows. Always
            visible (not hover-only) so collapsed groups always advertise
            their tab count. */}
        <span
          data-group-badge=""
          className="shrink-0 w-4 h-4 inline-flex items-center justify-center rounded text-[10px] font-semibold tabular-nums leading-none"
          title={`${group.tabs.length} ${group.tabs.length === 1 ? 'tab' : 'tabs'}`}
        >
          {group.tabs.length}
        </span>
        {/* Edge-style colored pill. SWALLOWS the chevron, content-sized
            via inline-flex (no flex-1), with `max-w-full` letting it grow
            up to the row's right edge for long names — at which point
            the inner name truncates. Action buttons are floated above
            the pill (see absolute overlay below) so the pill always has
            the full row to use; we don't have to leave a fixed gap on
            the right for them. */}
        <span
          data-group-pill=""
          className="inline-flex items-center gap-1 min-w-0 pl-1.5 pr-3 py-1 rounded-md text-xs font-medium overflow-hidden"
        >
          <span className="shrink-0 inline-flex items-center">
            {group.isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
          {isEditing ? (
            <InlineRenameInput
              value={editValue}
              onChange={setEditValue}
              onCommit={() => commitGroupRename(group.id)}
              onCancel={() => setEditingGroupId(null)}
              className="flex-1 min-w-0 bg-transparent outline-none placeholder:opacity-60 text-inherit"
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
        <div className="flex-1 overflow-y-auto pt-0 pb-0.5">
          {sidebarItems.map((item, sidebarIdx) => {
            if (item.type === 'tab') {
              return renderTabRow(item.tab, null, sidebarIdx)
            }
            const group = item.group
            return (
              <div
                key={item.id}
                data-group-container=""
                className="mb-0 relative"
                data-sidebar-block={sidebarIdx}
                style={{ ['--gc' as string]: group.color }}
              >
                {renderGroupHeader(group as GroupItem, sidebarIdx)}

                {!group.isCollapsed && (
                  <div data-group-children="">
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
            data-sidebar-row=""
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
        open={groupFromContextOpen}
        title={pendingGroupTabIds.length > 1 ? `Group ${pendingGroupTabIds.length} tabs` : 'New Group'}
        placeholder="Group name"
        onConfirm={(name) => {
          if (pendingGroupTabIds.length > 0) {
            moveTabsToNewGroup(pendingGroupTabIds, name)
            // Multi-tab group consumed the selection — clear it so the
            // moved tabs don't keep their selected highlight in their
            // new container.
            if (pendingGroupTabIds.length > 1) setSelectedTabIds(new Set())
          }
          setPendingGroupTabIds([])
          setGroupFromContextOpen(false)
        }}
        onCancel={() => {
          setPendingGroupTabIds([])
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
    </>
  )
}
