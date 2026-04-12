import { useState, useRef, useEffect } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppStore, saveStateNow } from '../store/app-store'
import { normalizeURL } from '../lib/url'
import { log } from '../lib/log'
import { InputDialog } from './InputDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { CertificatePopup } from './CertificatePopup'
import {
  ChevronLeft, ChevronRight, RotateCw, X, ChevronDown, Plus, Trash2, Pencil,
  PanelLeftClose, PanelLeft, User, Layout, Lock, Unlock, ShieldAlert, Import,
} from 'lucide-react'

interface Props {
  windowWorkspaceId: string | null
  sidebarVisible: boolean
  onToggleSidebar: () => void
}

function SortableDropdownRow({
  item,
  selected,
  icon: Icon,
  sortable,
  onSelect,
  onEdit,
  onDelete,
  canDelete,
}: {
  item: { id: string; name: string }
  selected: boolean
  icon: typeof User
  sortable: boolean
  onSelect: (id: string) => void
  onEdit?: (id: string, name: string) => void
  onDelete?: (id: string, name: string) => void
  canDelete?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !sortable,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
      className={`flex items-center gap-2 px-3 py-1.5 group/row transition-colors ${
        selected
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-accent/50'
      } ${isDragging ? 'opacity-60' : ''} ${sortable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <button
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        onClick={() => onSelect(item.id)}
      >
        <Icon size={12} className="text-muted-foreground shrink-0" />
        <span className="truncate">{item.name}</span>
      </button>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/row:opacity-100 transition-all">
        {onEdit && (
          <button
            data-row-action
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(item.id, item.name)
            }}
            title={`Rename ${item.name}`}
          >
            <Pencil size={11} />
          </button>
        )}
        {canDelete && onDelete && (
          <button
            data-row-action
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(item.id, item.name)
            }}
            title={`Delete ${item.name}`}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Custom dropdown with delete support */
function Dropdown({ items, value, onChange, onDelete, onEdit, onReorder, icon: Icon, label, onNew, newLabel, canDelete, extraActions }: {
  items: { id: string; name: string }[]
  value: string | null
  onChange: (id: string) => void
  onDelete?: (id: string, name: string) => void
  onEdit?: (id: string, name: string) => void
  onReorder?: (sourceId: string, sourceIndex: number, targetIndex: number) => void
  icon: typeof User
  label: string
  onNew?: () => void
  newLabel?: string
  canDelete?: boolean
  extraActions?: { label: string; icon: typeof User; onClick: () => void }[]
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = items.find((i) => i.id === value)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  )

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  const handleDragEnd = (event: DragEndEvent) => {
    if (!onReorder) return
    const { active, over } = event
    if (!over) {
      return
    }
    const sourceId = String(active.id)
    const targetId = String(over.id)
    if (sourceId === targetId) {
      return
    }
    const sourceIndex = items.findIndex((item) => item.id === sourceId)
    const targetIndex = items.findIndex((item) => item.id === targetId)
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      return
    }
    onReorder(sourceId, sourceIndex, targetIndex)
  }

  return (
    <div ref={ref} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-secondary hover:bg-accent text-secondary-foreground text-xs font-medium transition-colors"
      >
        <Icon size={13} className="text-muted-foreground" />
        <span className="max-w-[100px] truncate">{selected?.name || label}</span>
        <ChevronDown size={12} className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[200px] bg-popover border border-border rounded-lg shadow-lg py-1 text-xs">
          {onReorder ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                {items.map((item) => (
                  <SortableDropdownRow
                    key={item.id}
                    item={item}
                    selected={item.id === value}
                    icon={Icon}
                    sortable={true}
                    onSelect={(id) => { onChange(id); setOpen(false) }}
                    onEdit={onEdit ? (id, name) => { setOpen(false); onEdit(id, name) } : undefined}
                    onDelete={onDelete ? (id, name) => { setOpen(false); onDelete(id, name) } : undefined}
                    canDelete={canDelete}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <>
              {items.map((item) => (
                <SortableDropdownRow
                  key={item.id}
                  item={item}
                  selected={item.id === value}
                  icon={Icon}
                  sortable={false}
                  onSelect={(id) => { onChange(id); setOpen(false) }}
                  onEdit={onEdit ? (id, name) => { setOpen(false); onEdit(id, name) } : undefined}
                  onDelete={onDelete ? (id, name) => { setOpen(false); onDelete(id, name) } : undefined}
                  canDelete={canDelete}
                />
              ))}
            </>
          )}
          {(onNew || extraActions) && (
            <>
              <div className="h-px bg-border my-1" />
              {onNew && (
                <button
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary hover:bg-accent/50"
                  onClick={() => { onNew(); setOpen(false) }}
                >
                  <Plus size={12} />
                  {newLabel || 'Create New'}
                </button>
              )}
              {extraActions?.map((action) => (
                <button
                  key={action.label}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary hover:bg-accent/50"
                  onClick={() => { action.onClick(); setOpen(false) }}
                >
                  <action.icon size={12} />
                  {action.label}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function Toolbar({ windowWorkspaceId, sidebarVisible, onToggleSidebar }: Props) {
  const isMac = navigator.platform.includes('Mac')
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const addProfile = useAppStore((s) => s.addProfile)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const removeProfile = useAppStore((s) => s.removeProfile)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const renameProfile = useAppStore((s) => s.renameProfile)
  const renameWorkspace = useAppStore((s) => s.renameWorkspace)
  const moveWorkspace = useAppStore((s) => s.moveWorkspace)
  const importWorkspaceFromHtml = useAppStore((s) => s.importWorkspaceFromHtml)
  const getActiveProfile = useAppStore((s) => s.getActiveProfile)
  const getActiveTab = useAppStore((s) => s.getActiveTab)

  const activeProfile = getActiveProfile()
  const activeTab = getActiveTab()

  const [urlValue, setUrlValue] = useState(activeTab?.url || '')
  const urlRef = useRef<HTMLInputElement>(null)

  // Create/rename dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogTitle, setDialogTitle] = useState('')
  const [dialogPlaceholder, setDialogPlaceholder] = useState('')
  const [dialogDefault, setDialogDefault] = useState('')
  const [dialogAction, setDialogAction] = useState<'profile' | 'workspace' | 'rename-profile' | 'rename-workspace'>('profile')
  const [dialogTargetId, setDialogTargetId] = useState('')

  // Confirm delete dialog state
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmTitle, setConfirmTitle] = useState('')
  const [confirmMessage, setConfirmMessage] = useState('')
  const [confirmAction, setConfirmAction] = useState<() => void>(() => {})

  const [isLoading, setIsLoading] = useState(false)
  const [certPopupOpen, setCertPopupOpen] = useState(false)

  // Security state: 'secure' (valid HTTPS), 'insecure' (HTTP), 'warning' (cert error), 'internal' (about:, file:, etc.)
  type SecurityState = 'secure' | 'insecure' | 'warning' | 'internal'
  const [security, setSecurity] = useState<SecurityState>('internal')
  const [certInfo, setCertInfo] = useState('')
  const certErrorTabs = useRef(new Set<string>())

  useEffect(() => {
    const url = activeTab?.url || ''
    setUrlValue(url)
    if (activeTabId) updateSecurity(url, activeTabId)
  }, [activeTab?.url, activeTabId])

  // Derive security state from URL
  const updateSecurity = (url: string, tabId: string) => {
    if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('file:') || url.startsWith('chrome:')) {
      setSecurity('internal')
      setCertInfo('')
    } else if (certErrorTabs.current.has(tabId)) {
      setSecurity('warning')
      setCertInfo('Certificate error')
    } else if (url.startsWith('https://')) {
      setSecurity('secure')
      try {
        const host = new URL(url).hostname
        setCertInfo(`Connection to ${host} is secure`)
      } catch {
        setCertInfo('Secure connection')
      }
    } else if (url.startsWith('http://')) {
      setSecurity('insecure')
      setCertInfo('Connection is not secure')
    } else {
      setSecurity('internal')
      setCertInfo('')
    }
  }

  // Track webview loading state + security for the active tab
  useEffect(() => {
    if (!activeTabId) return
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as any
    if (!wv) { setIsLoading(false); setSecurity('internal'); return }

    // Check current state
    setIsLoading(wv.isLoading?.() ?? false)
    updateSecurity(wv.getURL?.() || activeTab?.url || '', activeTabId)

    const onStart = () => setIsLoading(true)
    const onStop = () => {
      setIsLoading(false)
      updateSecurity(wv.getURL?.() || '', activeTabId)
    }
    const onNavigate = (e: any) => {
      const url = e.url || ''
      if (!url.startsWith('data:')) updateSecurity(url, activeTabId)
    }
    const onCertError = () => {
      certErrorTabs.current.add(activeTabId)
      setSecurity('warning')
      setCertInfo('Certificate is not valid')
    }

    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('certificate-error', onCertError)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('certificate-error', onCertError)
    }
  }, [activeTabId])

  const handleNavigate = () => {
    const resolved = normalizeURL(urlValue)
    if (!resolved) return
    const webview = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as any
    if (webview) {
      const currentUrl = webview.getURL?.() || ''
      if (currentUrl === resolved) {
        if (webview.reloadIgnoringCache) webview.reloadIgnoringCache()
        else webview.reload?.()
      } else if (webview.loadURL) {
        webview.loadURL(resolved)
      } else {
        webview.src = resolved
      }
    }
    if (activeTabId) useAppStore.getState().updateTabUrl(activeTabId, resolved)
  }

  const handleBack = () => {
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as any
    if (wv?.canGoBack()) wv.goBack()
  }
  const handleForward = () => {
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as any
    if (wv?.canGoForward()) wv.goForward()
  }
  const handleReloadOrStop = () => {
    const wv = document.querySelector(`webview[data-tab-id="${activeTabId}"]`) as any
    if (!wv) return
    if (isLoading) {
      wv.stop()
    } else {
      const targetUrl = activeTab?.url || ''
      if (targetUrl && wv.loadURL) {
        wv.loadURL(targetUrl)
      } else if (wv.reloadIgnoringCache) {
        wv.reloadIgnoringCache()
      } else {
        wv.reload()
      }
    }
  }

  const openProfileDialog = () => {
    setDialogTitle('New Profile')
    setDialogPlaceholder('Profile name (e.g. Work, Fun)')
    setDialogDefault('')
    setDialogAction('profile')
    setDialogOpen(true)
  }

  const openWorkspaceDialog = () => {
    setDialogTitle('New Workspace')
    setDialogPlaceholder('Workspace name (e.g. Tasks, Research)')
    setDialogDefault('')
    setDialogAction('workspace')
    setDialogOpen(true)
  }

  const handleDialogConfirm = async (value: string) => {
    if (dialogAction === 'profile') {
      const profile = addProfile(value)
      log.action('createProfile', { id: profile.id, name: value })
      const ws = profile.workspaces[0]
      if (ws) {
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(profile.id, ws.id, ws.name)
      }
    } else if (dialogAction === 'workspace' && activeProfileId) {
      const ws = addWorkspace(activeProfileId, value)
      log.action('createWorkspace', { profileId: activeProfileId, wsId: ws.id, name: value })
      await saveStateNow()
      window.electronAPI.openWorkspaceWindow(activeProfileId, ws.id, ws.name)
    } else if (dialogAction === 'rename-profile') {
      renameProfile(dialogTargetId, value)
      log.action('renameProfile', { id: dialogTargetId, name: value })
    } else if (dialogAction === 'rename-workspace') {
      renameWorkspace(dialogTargetId, value)
      log.action('renameWorkspace', { id: dialogTargetId, name: value })
    }
    setDialogOpen(false)
    setDialogDefault('')
  }

  const handleProfileSelect = async (profileId: string) => {
    if (profileId === activeProfileId) return
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) return
    log.action('selectProfile', { id: profileId, name: profile.name })
    await saveStateNow()
    for (const ws of profile.workspaces) {
      window.electronAPI.openWorkspaceWindow(profile.id, ws.id, ws.name)
    }
  }

  const handleWorkspaceSelect = async (wsId: string) => {
    if (wsId === activeWorkspaceId) return
    if (!activeProfile) return
    const ws = activeProfile.workspaces.find((w) => w.id === wsId)
    if (ws) {
      log.action('selectWorkspace', { id: wsId, name: ws.name })
      await saveStateNow()
      window.electronAPI.openWorkspaceWindow(activeProfile.id, ws.id, ws.name)
    }
  }

  const handleWorkspaceReorder = (sourceId: string, sourceIndex: number, targetIndex: number) => {
    if (!activeProfile) return
    if (sourceIndex === targetIndex) return

    const insertIndex = sourceIndex < targetIndex ? targetIndex + 1 : targetIndex

    moveWorkspace(sourceId, insertIndex)
    void saveStateNow()
    log.action('reorderWorkspace', { sourceId, sourceIndex, targetIndex, insertIndex })
  }

  const handleEditProfile = (profileId: string, currentName: string) => {
    setDialogTitle('Rename Profile')
    setDialogPlaceholder('New profile name')
    setDialogDefault(currentName)
    setDialogAction('rename-profile')
    setDialogTargetId(profileId)
    setDialogOpen(true)
  }

  const handleEditWorkspace = (wsId: string, currentName: string) => {
    setDialogTitle('Rename Workspace')
    setDialogPlaceholder('New workspace name')
    setDialogDefault(currentName)
    setDialogAction('rename-workspace')
    setDialogTargetId(wsId)
    setDialogOpen(true)
  }

  const handleDeleteProfile = (profileId: string, profileName: string) => {
    if (profiles.length <= 1) return // can't delete the last profile
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) return
    const wsCount = profile.workspaces.length
    const tabCount = profile.workspaces.reduce((sum, w) =>
      sum + (w.tabs?.length || 0) + w.tabGroups.reduce((s, g) => s + g.tabs.length, 0), 0)

    setConfirmTitle(`Delete profile "${profileName}"?`)
    setConfirmMessage(
      `This will permanently delete ${wsCount} workspace${wsCount !== 1 ? 's' : ''} and ${tabCount} tab${tabCount !== 1 ? 's' : ''}. All related windows will be closed.`
    )
    setConfirmAction(() => async () => {
      log.action('deleteProfile', { id: profileId, name: profileName })
      // Close all workspace windows for this profile
      const wsIds = profile.workspaces.map((w) => w.id)
      await window.electronAPI.closeWorkspaceWindows(wsIds)
      // Remove from state
      removeProfile(profileId)
      await saveStateNow()
      setConfirmOpen(false)
    })
    setConfirmOpen(true)
  }

  const handleDeleteWorkspace = (wsId: string, wsName: string) => {
    if (!activeProfile || activeProfile.workspaces.length <= 1) return // can't delete the last workspace
    const ws = activeProfile.workspaces.find((w) => w.id === wsId)
    if (!ws) return
    const tabCount = (ws.tabs?.length || 0) + ws.tabGroups.reduce((s, g) => s + g.tabs.length, 0)

    setConfirmTitle(`Delete workspace "${wsName}"?`)
    setConfirmMessage(
      `This will permanently delete ${tabCount} tab${tabCount !== 1 ? 's' : ''}. The workspace window will be closed.`
    )
    setConfirmAction(() => async () => {
      log.action('deleteWorkspace', { id: wsId, name: wsName })
      // Close the workspace window
      await window.electronAPI.closeWorkspaceWindows([wsId])
      // Remove from state
      removeWorkspace(wsId)
      await saveStateNow()
      setConfirmOpen(false)
    })
    setConfirmOpen(true)
  }

  const handleImportWorkspace = async () => {
    if (!activeProfileId) return
    const html = await window.electronAPI.openBookmarkFile()
    if (!html) return
    const ws = importWorkspaceFromHtml(activeProfileId, html)
    if (ws) {
      log.action('importWorkspace', { profileId: activeProfileId, wsId: ws.id, name: ws.name })
      await saveStateNow()
      window.electronAPI.openWorkspaceWindow(activeProfileId, ws.id, ws.name)
    }
  }

  return (
    <>
      <div
        className="flex items-center gap-1.5 px-3 h-12 border-b border-border bg-card shrink-0"
        style={{
          paddingLeft: isMac ? 80 : 12,
          paddingRight: isMac ? 12 : 140,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        {/* Sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="h-8 w-8 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title="Toggle Sidebar"
        >
          {sidebarVisible ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
        </button>

        {/* Profile selector */}
        <Dropdown
          items={profiles.map((p) => ({ id: p.id, name: p.name }))}
          value={activeProfileId}
          onChange={handleProfileSelect}
          onDelete={handleDeleteProfile}
          onEdit={handleEditProfile}
          canDelete={profiles.length > 1}
          icon={User}
          label="Profile"
          onNew={openProfileDialog}
          newLabel="New Profile"
        />

        {/* Workspace selector */}
        <Dropdown
          items={activeProfile?.workspaces.map((w) => ({ id: w.id, name: w.name })) || []}
          value={activeWorkspaceId}
          onChange={handleWorkspaceSelect}
          onReorder={handleWorkspaceReorder}
          onDelete={handleDeleteWorkspace}
          onEdit={handleEditWorkspace}
          canDelete={(activeProfile?.workspaces.length || 0) > 1}
          icon={Layout}
          label="Workspace"
          onNew={openWorkspaceDialog}
          newLabel="New Workspace"
          extraActions={[{ label: 'Import Workspace', icon: Import, onClick: handleImportWorkspace }]}
        />

        <div className="w-px h-5 bg-border mx-1" />

        {/* Nav buttons */}
        <button
          onClick={handleBack}
          className="h-8 w-8 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={handleForward}
          className="h-8 w-8 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ChevronRight size={16} />
        </button>
        <button
          onClick={handleReloadOrStop}
          className="h-8 w-8 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={isLoading ? 'Stop loading' : 'Reload page'}
        >
          {isLoading ? <X size={14} /> : <RotateCw size={14} />}
        </button>

        {/* URL bar with security indicator */}
        <div
          className="flex-1 flex items-center h-8 rounded-md bg-secondary border border-input focus-within:border-ring focus-within:bg-background"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {security !== 'internal' && (
            <div
              className="pl-2.5 pr-0.5 flex items-center cursor-pointer group relative"
              onClick={() => setCertPopupOpen((v) => !v)}
            >
              {security === 'secure' && <Lock size={13} className="text-green-500" />}
              {security === 'insecure' && <Unlock size={13} className="text-muted-foreground" />}
              {security === 'warning' && <ShieldAlert size={13} className="text-red-500" />}
              {/* Tooltip centered under icon (hidden when popup is open) */}
              {!certPopupOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 hidden group-hover:block z-50 pointer-events-none">
                  <div className={`whitespace-nowrap px-3 py-1.5 rounded-md shadow-lg text-xs font-medium border ${
                    security === 'secure' ? 'bg-popover border-green-500/30 text-green-400' :
                    security === 'warning' ? 'bg-popover border-red-500/30 text-red-400' :
                    'bg-popover border-border text-muted-foreground'
                  }`}>
                    {certInfo}
                  </div>
                </div>
              )}
            </div>
          )}
          <input
            id="url-bar"
            ref={urlRef}
            type="text"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNavigate() }}
            placeholder="Enter URL or search..."
            spellCheck={false}
            className="flex-1 h-full px-2.5 bg-transparent border-none text-sm text-foreground outline-none"
          />
        </div>
      </div>

      <InputDialog
        open={dialogOpen}
        title={dialogTitle}
        placeholder={dialogPlaceholder}
        defaultValue={dialogDefault}
        confirmLabel={dialogAction.startsWith('rename') ? 'Rename' : 'Create'}
        onConfirm={handleDialogConfirm}
        onCancel={() => setDialogOpen(false)}
      />

      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        message={confirmMessage}
        onConfirm={confirmAction}
        onCancel={() => setConfirmOpen(false)}
      />

      {certPopupOpen && (
        <CertificatePopup
          open={certPopupOpen}
          url={activeTab?.url || ''}
          security={security}
          onClose={() => setCertPopupOpen(false)}
        />
      )}
    </>
  )
}
