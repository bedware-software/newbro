import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useAppStore, saveStateNow, findWorkspaceCandidates, buildBookmarkHTML } from '../store/app-store'
import { normalizeURL } from '../lib/url'
import { log } from '../lib/log'
import { suggestFor, subscribe as subscribeHistory, type Suggestion } from '../lib/history'
import { InputDialog } from './InputDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { CertificatePopup } from './CertificatePopup'
import { DownloadsPanel } from './DownloadsPanel'
import { ImportWorkspaceDialog } from './ImportWorkspaceDialog'
import { ExportWorkspaceDialog } from './ExportWorkspaceDialog'
import type { Workspace, WorkspaceCandidate } from '../store/types'
import type { DropdownAction, DropdownEvent, DropdownSpec, IconName } from './dropdown-protocol'
import { openDropdownAsync } from './dropdown-protocol'
import {
  ChevronLeft, ChevronRight, RotateCw, X, ChevronDown,
  User, Layout, Lock, Unlock, ShieldAlert,
  Menu, Globe, Copy, Check, Puzzle, Search, Download as DownloadIcon,
} from 'lucide-react'
import type { DownloadEntry } from '../App'

// Trigger-side icon registry. Only the icons used on dropdown trigger
// buttons appear here — row icons are resolved inside the popup window
// (see ICONS in DropdownMenuContent.tsx).
const TRIGGER_ICONS: Partial<Record<IconName, typeof User>> = {
  User, Layout, Menu,
}
function resolveTriggerIcon(name: IconName): typeof User {
  return TRIGGER_ICONS[name] ?? User
}

const isMacOS = navigator.platform.toLowerCase().includes('mac')

interface Props {
  windowWorkspaceId: string | null
  sidebarVisible: boolean
  onToggleSidebar: () => void
  onOpenSettings: () => void
  onOpenAbout: () => void
  onOpenSearch: () => void
  onManageExtensions: () => void
}

// Stable opener id per Dropdown / AppMenu instance. Echoed back on every
// dropdown event so multiple components can share the global event channel
// (and the popup window) without listeners crossing wires. Falls back to a
// non-crypto id when crypto.randomUUID isn't available.
function useOpenerId(): string {
  const ref = useRef<string>('')
  if (!ref.current) {
    ref.current = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  }
  return ref.current
}

// Subscribes to dropdown events and dispatches only the ones tagged with the
// caller's opener id. Subscribes for the lifetime of the component (not just
// while open) so the synthetic 'cancel' that arrives when our dropdown is
// superseded by another can still update our state.
function useDropdownEvents(openerId: string, handler: (evt: DropdownEvent) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    const cleanup = window.electronAPI.onDropdownEvent?.((evt: unknown) => {
      const e = evt as DropdownEvent
      if (e.openerId !== openerId) return
      handlerRef.current(e)
    })
    return cleanup
  }, [openerId])
}

// Capture the parent renderer's current theme so the popup window can mirror
// it on its own <html>. CSS variables live on the popup's document, not the
// parent's, so they have to be re-applied per window.
function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

interface DropdownTriggerProps {
  iconName: IconName
  items: { id: string; name: string }[]
  value: string | null
  onChange: (id: string) => void
  onDelete?: (id: string, name: string) => void
  onEdit?: (id: string, name: string) => void
  onReorder?: (sourceId: string, sourceIndex: number, targetIndex: number) => void
  label: string
  onNew?: () => void
  newLabel?: string
  canDelete?: boolean
  // Extra action rows shown below the items + "New" button. Each gets a
  // stable id used to route the popup's 'action' event back to its onClick.
  // `disabled` mirrors the IPC DropdownAction flag so callers can grey out
  // actions whose preconditions aren't met (e.g. Export with zero workspaces).
  actions?: { id: string; label: string; iconName: IconName; onClick: () => void; disabled?: boolean; disabledTitle?: string }[]
}

function Dropdown(props: DropdownTriggerProps) {
  const { iconName, items, value, onChange, onDelete, onEdit, onReorder, label, onNew, newLabel, canDelete, actions } = props
  const openerId = useOpenerId()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  // Whether the popup was open at the instant the trigger was pressed. Captured
  // on mousedown because clicking the trigger steals focus from the popup, whose
  // blur fires a 'cancel' that flips `open` to false before onClick runs — see
  // handleToggle for why reading `open` alone would re-open instead of close.
  const pressedOpenRef = useRef(false)
  const Icon = resolveTriggerIcon(iconName)
  const selected = items.find((i) => i.id === value)

  useDropdownEvents(openerId, (evt) => {
    switch (evt.type) {
      case 'select': onChange(evt.id); break
      case 'edit': onEdit?.(evt.id, evt.name); break
      case 'delete': onDelete?.(evt.id, evt.name); break
      case 'reorder': onReorder?.(evt.sourceId, evt.sourceIndex, evt.targetIndex); break
      case 'new': onNew?.(); break
      case 'action': {
        const action = actions?.find((a) => a.id === evt.actionId)
        action?.onClick()
        break
      }
      case 'cancel': break
    }
    if (evt.type !== 'reorder') setOpen(false)
  })

  const handleToggle = (): void => {
    // `open` can be a stale false here: the same click that's toggling the menu
    // also blurred the popup, and the resulting 'cancel' already flipped `open`.
    // pressedOpenRef (set on mousedown, before that cancel can land) is the
    // race-free signal for "was it open when pressed?".
    const wasOpen = open || pressedOpenRef.current
    pressedOpenRef.current = false
    if (wasOpen) {
      window.electronAPI.closeDropdown?.()
      setOpen(false)
      return
    }
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spec: DropdownSpec = {
      openerId,
      kind: 'list',
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      ...readThemeAttrs(),
      iconName,
      selectedId: value,
      items,
      reorder: !!onReorder,
      editable: !!onEdit,
      deletable: !!onDelete,
      canDelete,
      newAction: onNew ? { label: newLabel || 'Create New' } : undefined,
      actions: actions?.map((a): DropdownAction => ({
        id: a.id,
        label: a.label,
        iconName: a.iconName,
        ...(a.disabled ? { disabled: true } : {}),
        ...(a.disabledTitle ? { disabledTitle: a.disabledTitle } : {}),
      })),
    }
    window.electronAPI.openDropdown?.(spec)
    setOpen(true)
  }

  return (
    <div ref={triggerRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onMouseDown={() => { pressedOpenRef.current = open }}
        onClick={handleToggle}
        className="shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-secondary hover:bg-muted text-secondary-foreground text-xs font-medium transition-colors"
      >
        <Icon size={13} className="text-muted-foreground" />
        <span className="max-w-[100px] truncate">{selected?.name || label}</span>
        <ChevronDown size={12} className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  )
}

interface ExtensionInfo {
  id: string
  name: string
  version: string
  enabled: boolean
  pinned: boolean
  hasAction: boolean
  hasOptionsPage: boolean
  iconUrl?: string | null
  actionDefaultTitle?: string
}

/** Regex for the 32-char [a-p] Chrome/Edge extension ID, matched at the
 *  end of a detail path. Shared between store detection and the badge. */
const STORE_DETAIL_REGEX =
  /^https?:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)\/(?:detail|webstore\/detail)\/[^/]+\/([a-p]{32})/i

function extractExtensionIdFromStoreUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = url.match(STORE_DETAIL_REGEX)
  return m ? m[1] : null
}

/** Toolbar affordance for installing the extension currently shown in the
 *  active tab. Both the Chrome Web Store and Edge Add-ons block their own
 *  install buttons when they detect a non-Chrome/non-Edge browser — this
 *  is the reliable Newbro-side path. Visible only when the active tab's
 *  URL points at a store detail page. */
function StoreInstallBadge({ activeTabUrl }: { activeTabUrl: string | undefined }) {
  const [state, setState] = useState<'idle' | 'installing' | 'ok' | { error: string }>('idle')
  const extensionId = extractExtensionIdFromStoreUrl(activeTabUrl)
  // Reset success/error banner when the user navigates away or to a new listing.
  useEffect(() => { setState('idle') }, [extensionId])

  if (!extensionId) return null

  const handleClick = async (): Promise<void> => {
    if (state === 'installing') return
    setState('installing')
    try {
      const api = (window as any).electronAPI
      await api.installExtension(extensionId)
      setState('ok')
      setTimeout(() => setState('idle'), 3500)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({ error: msg })
      setTimeout(() => setState('idle'), 6000)
    }
  }

  let label = 'Install this extension'
  if (state === 'installing') label = 'Installing…'
  else if (state === 'ok') label = 'Installed ✓'
  else if (typeof state === 'object') label = 'Install failed'

  const title =
    typeof state === 'object' ? state.error : 'Download and install this extension into Newbro'

  return (
    <button
      onClick={handleClick}
      disabled={state === 'installing'}
      title={title}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`shrink-0 flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium transition-colors ${
        typeof state === 'object'
          ? 'bg-destructive text-destructive-foreground hover:opacity-90'
          : state === 'ok'
            ? 'bg-secondary text-secondary-foreground'
            : 'bg-primary text-primary-foreground hover:bg-primary/80'
      }`}
    >
      <Puzzle size={13} />
      <span>{label}</span>
    </button>
  )
}

/** Render a leading "Manage extensions" button followed by the pinned,
 *  enabled extensions that declare `action` as clickable icons. Click an
 *  icon to toggle its popup; right-click opens a Chrome-style context menu
 *  (pin/unpin, disable, options, remove, manage). */
/** Live, per-extension state pushed by main from the BrowserActionAPI in
 *  electron-chrome-extensions. Mirrors what chrome.action.setIcon /
 *  setBadgeText / setTitle / setPopup mutate. */
interface BrowserActionEntry {
  id: string
  title?: string
  popup?: string
  text?: string
  color?: string
  iconModified?: number
  tabs: Record<number, {
    title?: string
    popup?: string
    text?: string
    color?: string
    iconModified?: number
  }>
}
interface BrowserActionState {
  partition: string | null
  activeTabId?: number
  actions: BrowserActionEntry[]
}

function ExtensionActions({
  activeTabId,
  onManageExtensions,
}: {
  activeTabId: string | null
  onManageExtensions: () => void
}) {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([])
  const [actionState, setActionState] = useState<BrowserActionState>({
    partition: null,
    actions: [],
  })
  // Which extension's popup is currently open (one per window). Tracked so
  // the icon can render a pressed state and so a second click on the same
  // icon hits the toggle path.
  const [openPopupId, setOpenPopupId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.listExtensions) return
    api.listExtensions().then((list: ExtensionInfo[]) => setExtensions(list || []))
    const cleanupChange = api.onExtensionsChanged?.((list: ExtensionInfo[]) => setExtensions(list || []))
    const cleanupOpen = api.onExtensionPopupOpened?.((p: { extensionId: string }) =>
      setOpenPopupId(p.extensionId)
    )
    const cleanupClose = api.onExtensionPopupClosed?.(() => setOpenPopupId(null))
    // Prime + subscribe to dynamic browser-action state so chrome.action.setIcon
    // / setBadgeText updates immediately reflect on the toolbar icon.
    api.getBrowserActionState?.().then((p: { partition: string | null; state: { activeTabId?: number; actions: BrowserActionEntry[] } } | null) => {
      if (p) setActionState({ partition: p.partition, activeTabId: p.state.activeTabId, actions: p.state.actions })
    })
    const cleanupAction = api.onBrowserActionState?.((p: { partition: string; activeTabId?: number; actions: BrowserActionEntry[] }) => {
      log.event('toolbar.onBrowserActionState', {
        partition: p.partition,
        activeTabId: p.activeTabId,
        actions: (p.actions || []).map((a) => ({
          id: a.id,
          text: a.text,
          color: a.color,
          iconMod: a.iconModified,
        })),
      })
      setActionState({ partition: p.partition, activeTabId: p.activeTabId, actions: p.actions })
    })
    return () => { cleanupChange?.(); cleanupOpen?.(); cleanupClose?.(); cleanupAction?.() }
  }, [])

  // When the open popup's extension gets unpinned/uninstalled/disabled, ask
  // main to close it so the floating panel doesn't outlive its anchor.
  useEffect(() => {
    if (!openPopupId) return
    const stillVisible = extensions.some(
      (e) => e.id === openPopupId && e.enabled && e.pinned && e.hasAction
    )
    if (!stillVisible) {
      const api = (window as any).electronAPI
      api?.closeExtensionPopup?.()
    }
  }, [extensions, openPopupId])

  // Close the popup on any mousedown in the renderer that isn't on the
  // open icon's button (clicking the icon itself goes through the toggle
  // path). Tab clicks are handled main-side via webContents 'input-event'.
  useEffect(() => {
    if (!openPopupId) return
    const onMouseDown = (e: MouseEvent): void => {
      const btn = buttonRefs.current.get(openPopupId)
      if (btn && btn.contains(e.target as Node)) return
      const api = (window as any).electronAPI
      api?.closeExtensionPopup?.()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [openPopupId])

  const visible = extensions.filter((e) => e.enabled && e.hasAction && (e.pinned ?? true))

  const buttonAnchor = (id: string): { x: number; y: number; width: number; height: number } => {
    const btn = buttonRefs.current.get(id)
    if (!btn) return { x: 0, y: 0, width: 0, height: 0 }
    const r = btn.getBoundingClientRect()
    return { x: r.left, y: r.top, width: r.width, height: r.height }
  }

  const handleClick = (ext: ExtensionInfo): void => {
    const api = (window as any).electronAPI
    const anchor = buttonAnchor(ext.id)
    api?.openExtensionAction?.(ext.id, activeTabId, anchor).then((result: string) => {
      if (result === 'no-popup') {
        // No popup declared — fall back to the options page, which is what
        // Chrome does when `default_popup` is empty.
        api?.openExtensionOptions?.(ext.id)
      }
    })
  }

  const handleContextMenu = async (ext: ExtensionInfo, e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const api = (window as any).electronAPI
    const isPinned = ext.pinned ?? true
    const actions: DropdownAction[] = [
      {
        id: isPinned ? 'unpin' : 'pin',
        label: isPinned ? 'Unpin from toolbar' : 'Pin to toolbar',
        iconName: isPinned ? 'PinOff' : 'Pin',
      },
    ]
    if (ext.hasOptionsPage) {
      actions.push({ id: 'options', label: 'Options', iconName: 'Settings' })
    }
    actions.push({ id: 'disable', label: 'Disable extension', iconName: 'EyeOff', divider: 'before' })
    actions.push({ id: 'remove', label: 'Remove from Newbro', iconName: 'Trash2', destructive: true })
    actions.push({ id: 'manage', label: 'Manage extensions', iconName: 'Puzzle', divider: 'before' })

    const result = await openDropdownAsync({
      kind: 'menu',
      position: { x: e.clientX, y: e.clientY },
      ...readThemeAttrs(),
      header: ext.name,
      actions,
    })
    if (!result || result.type !== 'action') return
    switch (result.actionId) {
      case 'pin':
        await api?.setExtensionPinned?.(ext.id, true)
        break
      case 'unpin':
        await api?.setExtensionPinned?.(ext.id, false)
        break
      case 'options':
        await api?.openExtensionOptions?.(ext.id)
        break
      case 'disable':
        await api?.setExtensionEnabled?.(ext.id, false)
        break
      case 'remove':
        await api?.uninstallExtension?.(ext.id)
        break
      case 'manage':
        onManageExtensions()
        break
    }
  }

  return (
    <div
      ref={containerRef}
      className="flex items-center gap-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Leading "Manage extensions" button — opens Settings → Extensions.
          Always shown (even with no pinned extensions) so it stays a
          reliable entry point, mirroring Chrome's puzzle-piece menu. */}
      <button
        onClick={onManageExtensions}
        title="Manage extensions"
        className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground transition-colors"
      >
        <Puzzle size={15} />
      </button>
      {visible.map((ext) => {
        const isOpen = openPopupId === ext.id
        const action = actionState.actions.find((a) => a.id === ext.id)
        // Per-tab override beats the action-global value beats the manifest
        // default — same precedence chrome.action follows. Renderer doesn't
        // know its own tabId, but the library's getState carries the
        // active-tab id from the *partition* this window owns, which is what
        // we want anyway.
        const tabState = action && actionState.activeTabId != null
          ? action.tabs[actionState.activeTabId]
          : undefined
        const dynamicTitle = tabState?.title ?? action?.title
        const dynamicText = tabState?.text ?? action?.text
        const dynamicColor = tabState?.color ?? action?.color ?? '#666'
        const iconModified = tabState?.iconModified ?? action?.iconModified
        // Use the library's crx:// route when we have a live action entry
        // for this extension — that way chrome.action.setIcon is reflected
        // immediately. Fall back to the static manifest iconUrl otherwise.
        let iconSrc: string | null | undefined = ext.iconUrl
        if (action && actionState.partition) {
          const params = new URLSearchParams({
            tabId: actionState.activeTabId != null ? `${actionState.activeTabId}` : '-1',
            partition: actionState.partition,
          })
          if (iconModified) params.set('t', String(iconModified))
          iconSrc = `crx://extension-icon/${ext.id}/32/2?${params.toString()}`
        }
        return (
          <button
            key={ext.id}
            ref={(el) => {
              if (el) buttonRefs.current.set(ext.id, el)
              else buttonRefs.current.delete(ext.id)
            }}
            onClick={() => handleClick(ext)}
            onContextMenu={(e) => handleContextMenu(ext, e)}
            title={dynamicTitle || ext.actionDefaultTitle || ext.name}
            className={`relative h-8 w-8 shrink-0 flex items-center justify-center rounded-md overflow-hidden transition-colors ${
              isOpen ? 'bg-muted text-foreground' : 'hover:bg-muted text-secondary-foreground'
            }`}
          >
            {iconSrc ? (
              <img
                src={iconSrc}
                alt=""
                className="w-5 h-5"
                onError={(e) => {
                  // Fall back to the static manifest icon if the dynamic
                  // crx:// fetch fails (icon not yet processed, partition
                  // closed, etc.). Hides the broken-image glyph either way.
                  const img = e.currentTarget as HTMLImageElement
                  if (ext.iconUrl && img.src !== ext.iconUrl) {
                    img.src = ext.iconUrl
                  } else {
                    img.style.display = 'none'
                  }
                }}
              />
            ) : (
              <Puzzle size={15} />
            )}
            {dynamicText ? (
              <span
                className="absolute bottom-0 right-0 text-[9px] leading-none font-semibold px-[3px] py-[1px] rounded-sm text-white pointer-events-none"
                style={{ backgroundColor: dynamicColor }}
              >
                {dynamicText}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function AppMenu({ sidebarVisible, onToggleSidebar, onOpenSettings, onOpenAbout, onOpenSearch }: { sidebarVisible: boolean; onToggleSidebar: () => void; onOpenSettings: () => void; onOpenAbout: () => void; onOpenSearch: () => void }) {
  const openerId = useOpenerId()
  const [open, setOpen] = useState(false)
  const [updatesUnsupported, setUpdatesUnsupported] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  // See Dropdown's pressedOpenRef: captures the open-state on mousedown so the
  // toggle isn't fooled by the blur-driven 'cancel' that races the click.
  const pressedOpenRef = useRef(false)

  // Track whether the running build supports auto-updates. The main process
  // marks unpacked / dev builds with phase: 'unsupported'; we read it once
  // at mount and stay subscribed for any later flip (won't happen in
  // practice, but keeps the UI consistent if it ever does).
  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return
    api.getUpdaterStatus?.().then((s: { phase?: string } | null) => {
      if (s?.phase === 'unsupported') setUpdatesUnsupported(true)
    })
    const cleanup = api.onUpdaterStatus?.((s: { phase?: string }) => {
      setUpdatesUnsupported(s?.phase === 'unsupported')
    })
    return cleanup
  }, [])

  // Action handlers keyed by id — same dispatch table the popup will route
  // through via the 'action' event.
  const ACTIONS: Record<string, () => void> = {
    'toggle-sidebar': onToggleSidebar,
    'search': onOpenSearch,
    'settings': onOpenSettings,
    'check-updates': () => { (window as any).electronAPI.checkForUpdates?.() },
    'about': onOpenAbout,
    'exit': () => window.electronAPI.quit(),
  }

  useDropdownEvents(openerId, (evt) => {
    if (evt.type === 'action') {
      ACTIONS[evt.actionId]?.()
    }
    setOpen(false)
  })

  const buildActions = (): DropdownAction[] => {
    const modKey = isMacOS ? '⌘' : 'Ctrl'
    return [
      {
        id: 'toggle-sidebar',
        label: sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar',
        iconName: sidebarVisible ? 'PanelLeftClose' : 'PanelLeft',
        shortcut: [modKey, '\\'],
      },
      { id: 'search', label: 'Search Everything', iconName: 'Search', shortcut: [modKey, 'O'] },
      { id: 'settings', label: 'Settings', iconName: 'Settings', shortcut: [modKey, ','] },
      {
        id: 'check-updates',
        label: updatesUnsupported ? 'Updates Unavailable (Dev Build)' : 'Check for Updates…',
        iconName: 'Download',
        disabled: updatesUnsupported,
        disabledTitle: 'Updates are only available in installed builds.',
      },
      { id: 'about', label: 'About', iconName: 'Info' },
      { id: 'exit', label: 'Exit', iconName: 'LogOut', divider: 'before', destructive: true },
    ]
  }

  const handleToggle = (): void => {
    // `open` may already be a stale false (the click that's toggling the menu
    // blurred the popup, whose 'cancel' flipped it). pressedOpenRef, set on
    // mousedown before that cancel lands, is the race-free "was it open?" signal.
    const wasOpen = open || pressedOpenRef.current
    pressedOpenRef.current = false
    if (wasOpen) {
      window.electronAPI.closeDropdown?.()
      setOpen(false)
      return
    }
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spec: DropdownSpec = {
      openerId,
      kind: 'menu',
      anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      ...readThemeAttrs(),
      actions: buildActions(),
    }
    window.electronAPI.openDropdown?.(spec)
    setOpen(true)
  }

  return (
    <div ref={triggerRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        onMouseDown={() => { pressedOpenRef.current = open }}
        onClick={handleToggle}
        className="h-8 px-2 shrink-0 flex items-center gap-1 rounded-md bg-secondary hover:bg-muted text-secondary-foreground text-xs font-medium"
      >
        <Menu size={15} />
        <span>Menu</span>
      </button>
    </div>
  )
}

function ActiveTabTitle({ title, favicon, comment }: { title: string; favicon?: string; comment?: string }) {
  const displayTitle = comment ? `${comment} — ${title}` : title
  const textRef = useRef<HTMLSpanElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [faviconBroken, setFaviconBroken] = useState(false)

  // Reset broken state when the favicon URL changes.
  useEffect(() => { setFaviconBroken(false) }, [favicon])

  useEffect(() => {
    const el = textRef.current
    const container = containerRef.current
    if (!el || !container) return
    setIsOverflowing(el.scrollWidth > container.clientWidth)
  }, [displayTitle])

  const handleCopy = () => {
    navigator.clipboard.writeText(displayTitle)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="group/tabtitle flex-[3] min-w-0 hidden min-[1200px]:flex items-center gap-2 h-8 rounded-md bg-secondary hover:bg-muted px-2.5"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={displayTitle}
    >
      <div className="relative shrink-0 w-4 h-4 flex items-center justify-center">
        {favicon && !faviconBroken ? (
          <img
            key={favicon}
            src={favicon}
            className={`w-4 h-4 rounded-sm transition-opacity ${copied ? 'opacity-0' : 'group-hover/tabtitle:opacity-0'}`}
            alt=""
            draggable={false}
            onError={() => setFaviconBroken(true)}
          />
        ) : (
          <Globe size={14} className={`text-muted-foreground transition-opacity ${copied ? 'opacity-0' : 'group-hover/tabtitle:opacity-0'}`} />
        )}
        <button
          onClick={handleCopy}
          className={`absolute inset-0 flex items-center justify-center text-muted-foreground hover:text-foreground transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/tabtitle:opacity-100'}`}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div ref={containerRef} className="flex-1 overflow-hidden">
        <span
          ref={textRef}
          className={`block truncate text-foreground cursor-default ${isOverflowing ? 'text-xs' : 'text-sm'}`}
        >
          {displayTitle}
        </span>
      </div>
    </div>
  )
}

export function Toolbar({ windowWorkspaceId, sidebarVisible, onToggleSidebar, onOpenSettings, onOpenAbout, onOpenSearch, onManageExtensions }: Props) {
  const isMac = navigator.platform.includes('Mac')
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const certBypassedOrigins = useAppStore((s) => s.certBypassedOrigins)
  const addProfile = useAppStore((s) => s.addProfile)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const removeProfile = useAppStore((s) => s.removeProfile)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)
  const renameProfile = useAppStore((s) => s.renameProfile)
  const renameWorkspace = useAppStore((s) => s.renameWorkspace)
  const moveWorkspace = useAppStore((s) => s.moveWorkspace)
  const importSelectedWorkspaces = useAppStore((s) => s.importSelectedWorkspaces)
  const getActiveProfile = useAppStore((s) => s.getActiveProfile)
  const getActiveTab = useAppStore((s) => s.getActiveTab)

  const activeProfile = getActiveProfile()
  const activeTab = getActiveTab()

  const [urlValue, setUrlValue] = useState(activeTab?.url || '')
  const urlRef = useRef<HTMLInputElement>(null)

  // Address-bar autocomplete state. The "typed" portion is what the user
  // actually typed (no protocol guessing, no suggestion); the suggestion's
  // suffix is appended to the input value and shown selected so further
  // typing replaces it naturally. Tab accepts the suggestion (collapses the
  // selection to the end). Empty suggestion = no autocomplete active.
  //
  // - autoActive: true while the user is editing in the URL bar. We don't
  //   want history suggestions overriding the URL we sync from active tab
  //   navigation, only when the user is actively typing.
  // - suggestion: holds the matched URL plus its tail and navigation target
  //   so Enter can dispatch to the right place even after Tab.
  const [autoActive, setAutoActive] = useState(false)
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const typedRef = useRef<string>('')
  // Subscribe to history-cache updates so suggestions reflect the latest
  // snapshot from main. We don't read it directly here — suggestFor() pulls
  // from the cache at call time — but this re-renders the address-bar
  // effects when the cache changes so a freshly-visited URL becomes
  // available immediately.
  const [, setHistoryTick] = useState(0)
  useEffect(() => subscribeHistory(() => setHistoryTick((n) => n + 1)), [])

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

  // Import workspace dialog state
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importCandidates, setImportCandidates] = useState<WorkspaceCandidate[]>([])

  // Export workspace dialog state
  const [exportDialogOpen, setExportDialogOpen] = useState(false)

  const [isLoading, setIsLoading] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [certPopupOpen, setCertPopupOpen] = useState(false)

  // Downloads — open state for the panel + a cached active-count so the
  // toolbar button shows a progress dot while there's a download in flight.
  // The badge tracks live downloads only (history doesn't count); it stays
  // in sync via the global onDownloadsUpdated broadcast.
  const [downloadsPanelOpen, setDownloadsPanelOpen] = useState(false)
  const [activeDownloads, setActiveDownloads] = useState(0)
  useEffect(() => {
    let alive = true
    const tally = (list: DownloadEntry[] | undefined): number => {
      if (!list) return 0
      let n = 0
      for (const e of list) {
        if (e.state === 'progressing' || e.state === 'paused') n++
      }
      return n
    }
    void window.electronAPI.downloadsList?.().then((list) => {
      if (!alive) return
      setActiveDownloads(tally(list as DownloadEntry[] | undefined))
    })
    const cleanup = window.electronAPI.onDownloadsUpdated?.((list) => {
      setActiveDownloads(tally(list as DownloadEntry[] | undefined))
    })
    return () => { alive = false; cleanup?.() }
  }, [])

  // Security state: 'secure' (valid HTTPS), 'insecure' (HTTP), 'warning' (cert error), 'internal' (about:, file:, etc.)
  type SecurityState = 'secure' | 'insecure' | 'warning' | 'internal'
  const [security, setSecurity] = useState<SecurityState>('internal')
  const [certInfo, setCertInfo] = useState('')
  const certErrorTabs = useRef(new Set<string>())

  // Listen for the renderer-wide "new workspace" shortcut dispatched from
  // App.tsx so the keyboard shortcut (CmdOrCtrl+Shift+N) reuses the same
  // input dialog as the toolbar's New Workspace button. State setters are
  // stable, so no deps are needed.
  useEffect(() => {
    const handler = () => {
      setDialogTitle('New Workspace')
      setDialogPlaceholder('Workspace name (e.g. Tasks, Research)')
      setDialogDefault('')
      setDialogAction('workspace')
      setDialogOpen(true)
    }
    window.addEventListener('newbro-open-new-workspace-dialog', handler)
    return () => window.removeEventListener('newbro-open-new-workspace-dialog', handler)
  }, [])

  useEffect(() => {
    const url = activeTab?.url || ''
    // While the user is actively editing the address bar, don't let
    // background tab.url updates (did-navigate fired by a backgrounded tab,
    // a redirect on the current tab settling after the user already started
    // typing, etc.) clobber their input. Security state still tracks the
    // real URL.
    if (autoActive) {
      if (activeTabId) updateSecurity(url, activeTabId)
      return
    }
    // Preserve the "select-all" state across a value sync. When the user
    // opens a new tab with the "focus URL bar" preference, we focus +
    // select-all the input. Any subsequent activeTab.url update from the
    // store (did-navigate, redirects, final page URL once the load
    // finishes, or a security-state-driven re-render) would otherwise
    // clobber the highlight — React rewrites the input's value and the
    // browser resets the selection. If the input is focused AND was
    // fully selected before the sync, reapply the select after React
    // commits the new value.
    const input = urlRef.current
    const hadFullSelection =
      !!input &&
      document.activeElement === input &&
      input.value.length > 0 &&
      input.selectionStart === 0 &&
      input.selectionEnd === input.value.length
    setUrlValue(url)
    setSuggestion(null)
    typedRef.current = ''
    if (activeTabId) updateSecurity(url, activeTabId)
    if (hadFullSelection) {
      setTimeout(() => {
        const el = urlRef.current
        if (!el || document.activeElement !== el) return
        try { el.select() }
        catch (err) { console.warn('Toolbar: urlRef.select() threw:', err) }
      }, 0)
    }
  }, [activeTab?.url, activeTabId, certBypassedOrigins, autoActive])

  // Derive security state from URL
  const updateSecurity = (url: string, tabId: string) => {
    if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('file:') || url.startsWith('chrome:')) {
      setSecurity('internal')
      setCertInfo('')
      return
    }
    // Session-bypassed cert? Show warning even though the load succeeded.
    // Read from the store directly to avoid stale closures in webview event
    // listeners (which are registered once per activeTabId change).
    let origin = ''
    try { origin = new URL(url).origin }
    catch (err) {
      // Non-URL strings (e.g. "about:blank", malformed entries) reach
      // this path. Surface anything unexpected; treat the resulting
      // empty origin as "no bypass" and continue.
      console.warn('Toolbar: updateSecurity URL parse failed', { url, err: String(err) })
    }
    const bypassed = useAppStore.getState().certBypassedOrigins
    if (origin && bypassed.has(origin)) {
      setSecurity('warning')
      setCertInfo('You bypassed a certificate warning for this site')
      return
    }
    if (certErrorTabs.current.has(tabId)) {
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

  // Track loading state + security for the active tab. Tabs now live in
  // main as WebContentsViews; we subscribe to tab-event via electronAPI
  // instead of wiring DOM events on a <webview> element.
  useEffect(() => {
    if (!activeTabId) return
    let cancelled = false

    // Seed from the live main-process state in case the tab was already
    // navigating/loaded when this effect re-runs (e.g. on tab switch).
    window.electronAPI.tabGetState?.(activeTabId).then((state) => {
      if (cancelled || !state) return
      setIsLoading(state.isLoading)
      setCanGoForward(state.canGoForward)
      updateSecurity(state.url || activeTab?.url || '', activeTabId)
    })

    const refreshNavState = (): void => {
      window.electronAPI.tabGetState?.(activeTabId).then((state) => {
        if (cancelled || !state) return
        setCanGoForward(state.canGoForward)
      })
    }

    const cleanup = window.electronAPI.onTabEvent?.((raw) => {
      const evt = raw as {
        type: string
        tabId: string
        url?: string
      }
      if (evt.tabId !== activeTabId) return
      switch (evt.type) {
        case 'did-start-loading':
          setIsLoading(true)
          break
        case 'did-stop-loading':
          setIsLoading(false)
          if (evt.url) updateSecurity(evt.url, activeTabId)
          break
        case 'did-navigate':
        case 'did-navigate-in-page':
          if (evt.url && !evt.url.startsWith('data:')) updateSecurity(evt.url, activeTabId)
          // canGoForward only changes on real history mutations, but
          // refreshing here covers both forward/back and brand-new loads.
          refreshNavState()
          break
        case 'did-fail-load': {
          const full = raw as { errorCode?: number }
          const code = full.errorCode ?? 0
          // ERR_CERT_* (-200..-219) and ERR_INSECURE_RESPONSE (-501) all
          // surface as the warning chip on the URL bar.
          if ((code >= -219 && code <= -200) || code === -501) {
            certErrorTabs.current.add(activeTabId)
            setSecurity('warning')
            setCertInfo('Certificate is not valid')
          }
          break
        }
        default:
          break
      }
    })

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [activeTabId])

  const handleNavigate = async () => {
    // If the user pressed Enter with a live autocomplete suggestion, treat
    // their accepted URL as the navigation target — not the bare typed
    // prefix that's also still in the value pre-acceptance. We commit the
    // suggestion's canonical URL (which still goes through normalizeURL so
    // bare hosts get https:// prepended).
    const inputText = suggestion ? suggestion.url : urlValue
    const resolved = normalizeURL(inputText)
    if (!resolved || !activeTabId) return
    setSuggestion(null)
    setAutoActive(false)
    typedRef.current = ''
    // Ask main for the live URL so hitting Enter on an unchanged URL triggers
    // a reload (matches old <webview>.reload behavior), not a redundant load.
    const state = await window.electronAPI.tabGetState?.(activeTabId)
    if (state && state.url === resolved) {
      window.electronAPI.tabReload?.(activeTabId, true)
    } else {
      window.electronAPI.tabNavigate?.(activeTabId, resolved)
    }
    useAppStore.getState().updateTabUrl(activeTabId, resolved)
  }

  // When a suggestion is active, set the input's selection to cover the
  // appended suffix so further typing replaces it (same trick Chrome /
  // Firefox use). Runs in layout effect so it lands before paint and the
  // user never sees the unselected appended chars flicker.
  useLayoutEffect(() => {
    const input = urlRef.current
    if (!input) return
    if (!suggestion || !autoActive) return
    if (document.activeElement !== input) return
    const typedLen = urlValue.length - suggestion.suffix.length
    if (typedLen < 0) return
    try { input.setSelectionRange(typedLen, urlValue.length) }
    catch (err) { console.warn('Toolbar: url suggestion setSelectionRange threw:', err) }
  }, [urlValue, suggestion, autoActive])

  // Compute the next state after an edit. Detects deletion vs insertion
  // from InputEvent.inputType so backspace doesn't immediately re-suggest
  // the same URL the user just deleted from (which would be infuriating).
  // Returns the typed portion plus an optional suggestion to surface.
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const next = e.target.value
    const inputType = (e.nativeEvent as InputEvent).inputType
    const isDeletion = inputType ? inputType.startsWith('delete') : next.length < typedRef.current.length
    const isPaste = inputType === 'insertFromPaste'
    const isComposition = inputType === 'insertCompositionText'

    typedRef.current = next
    if (isDeletion || isPaste || isComposition) {
      // No autocomplete after delete / paste / IME. The user either wants
      // the bare value they ended up with, or we'd interfere with the
      // composition session.
      setUrlValue(next)
      setSuggestion(null)
      return
    }

    const match = suggestFor(next)
    if (!match) {
      setUrlValue(next)
      setSuggestion(null)
      return
    }
    setUrlValue(next + match.suffix)
    setSuggestion(match)
  }

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      // Enter accepts whatever's showing — the navigation handler reads
      // suggestion.url when a suggestion is present so a partial-typed
      // value still navigates to the matched URL.
      handleNavigate()
      return
    }
    if (e.key === 'Tab' && suggestion) {
      // Accept the suggestion: collapse selection to end, keep the value.
      // preventDefault so Tab doesn't move focus to the next element.
      e.preventDefault()
      const input = urlRef.current
      typedRef.current = urlValue
      setSuggestion(null)
      if (input) {
        const end = urlValue.length
        try { input.setSelectionRange(end, end) }
        catch (err) { console.warn('Toolbar: url Tab accept setSelectionRange threw:', err) }
      }
      return
    }
    if (e.key === 'Escape' && suggestion) {
      // First Esc: back out of autocomplete, keep the typed text, and stay
      // in the URL bar — the browser convention of "dismiss the suggestion
      // without losing what I typed." stopPropagation keeps the global Esc
      // handler (App.tsx) from also firing and yanking focus to the page;
      // a second Esc (now with no suggestion) does that instead.
      e.preventDefault()
      e.stopPropagation()
      const typed = typedRef.current
      setUrlValue(typed)
      setSuggestion(null)
      return
    }
  }

  const handleBack = () => {
    if (activeTabId) window.electronAPI.tabGoBack?.(activeTabId)
  }
  const handleForward = () => {
    if (activeTabId) window.electronAPI.tabGoForward?.(activeTabId)
  }
  const handleReloadOrStop = () => {
    if (!activeTabId) return
    if (isLoading) {
      window.electronAPI.tabStop?.(activeTabId)
    } else {
      // Reload, not re-navigate. tabNavigate(currentUrl) would push a
      // fresh history entry on every refresh click — matches neither
      // Chrome nor the URL-bar Enter-on-unchanged-URL path. See the
      // 'reload' case in App.tsx for the same reasoning.
      window.electronAPI.tabReload?.(activeTabId, true)
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
    const candidates = findWorkspaceCandidates(html)
    log.action('importWorkspaceScan', { profileId: activeProfileId, count: candidates.length })
    setImportCandidates(candidates)
    setImportDialogOpen(true)
  }

  const handleImportConfirm = async (selected: WorkspaceCandidate[]) => {
    if (!activeProfileId || selected.length === 0) {
      setImportDialogOpen(false)
      return
    }
    const created = importSelectedWorkspaces(activeProfileId, selected)
    for (const ws of created) {
      log.action('importWorkspace', { profileId: activeProfileId, wsId: ws.id, name: ws.name })
    }
    await saveStateNow()
    setImportDialogOpen(false)
    setImportCandidates([])
  }

  const handleExportWorkspace = () => {
    if (!activeProfile || activeProfile.workspaces.length === 0) return
    setExportDialogOpen(true)
  }

  const handleExportConfirm = async (selected: Workspace[]) => {
    setExportDialogOpen(false)
    if (selected.length === 0) return
    const html = buildBookmarkHTML(selected)
    // Default filename: a single workspace exports as `<name>.html`;
    // multi-select falls back to a profile-scoped name so the user can
    // spot the file at a glance in their downloads folder. Sanitise the
    // base name so reserved filesystem characters (`/ \ : * ? " < > |`)
    // can't reach the OS save dialog — they'd be silently stripped or
    // outright rejected on Windows.
    const sanitise = (s: string): string => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Workspace'
    const suggestedName = selected.length === 1
      ? `${sanitise(selected[0].name)}.html`
      : `${sanitise(activeProfile?.name || 'Newbro')} Workspaces.html`
    const saved = await window.electronAPI.saveBookmarkFile(html, suggestedName)
    log.action('exportWorkspaces', {
      profileId: activeProfileId,
      count: selected.length,
      saved,
    })
  }

  // Command-palette entry points that piggy-back on Toolbar-owned flows
  // (file picker, candidate parsing, ExportWorkspaceDialog state, the
  // rename InputDialog, the delete ConfirmDialog, the save-bookmark-file
  // IPC). Refs keep the listeners thin while still dispatching the
  // latest closure — empty-deps capture would freeze activeProfile /
  // activeWorkspaceId on the first render. MUST be declared after every
  // handler in this block; `const` TDZ means useRef(handleX) at the top
  // of the component would throw ReferenceError before handleX existed,
  // blanking the renderer.
  const handleImportRef = useRef(handleImportWorkspace)
  const handleExportRef = useRef(handleExportWorkspace)
  const handleEditProfileRef = useRef(handleEditProfile)
  const handleDeleteProfileRef = useRef(handleDeleteProfile)
  const handleEditWorkspaceRef = useRef(handleEditWorkspace)
  const handleDeleteWorkspaceRef = useRef(handleDeleteWorkspace)
  const activeProfileRef = useRef(activeProfile)
  const activeWorkspaceIdRef = useRef(activeWorkspaceId)
  handleImportRef.current = handleImportWorkspace
  handleExportRef.current = handleExportWorkspace
  handleEditProfileRef.current = handleEditProfile
  handleDeleteProfileRef.current = handleDeleteProfile
  handleEditWorkspaceRef.current = handleEditWorkspace
  handleDeleteWorkspaceRef.current = handleDeleteWorkspace
  activeProfileRef.current = activeProfile
  activeWorkspaceIdRef.current = activeWorkspaceId
  useEffect(() => {
    const onImport = () => { void handleImportRef.current() }
    const onExport = () => { handleExportRef.current() }
    const onRenameProfile = () => {
      const p = activeProfileRef.current
      if (p) handleEditProfileRef.current(p.id, p.name)
    }
    const onDeleteProfile = () => {
      const p = activeProfileRef.current
      if (p) handleDeleteProfileRef.current(p.id, p.name)
    }
    const onRenameWorkspace = () => {
      const p = activeProfileRef.current
      const wsId = activeWorkspaceIdRef.current
      if (!p || !wsId) return
      const ws = p.workspaces.find((w) => w.id === wsId)
      if (ws) handleEditWorkspaceRef.current(ws.id, ws.name)
    }
    const onDeleteWorkspace = () => {
      const p = activeProfileRef.current
      const wsId = activeWorkspaceIdRef.current
      if (!p || !wsId) return
      const ws = p.workspaces.find((w) => w.id === wsId)
      if (ws) handleDeleteWorkspaceRef.current(ws.id, ws.name)
    }
    window.addEventListener('newbro-open-import-workspaces', onImport)
    window.addEventListener('newbro-open-export-workspaces', onExport)
    window.addEventListener('newbro-rename-active-profile', onRenameProfile)
    window.addEventListener('newbro-delete-active-profile', onDeleteProfile)
    window.addEventListener('newbro-rename-active-workspace', onRenameWorkspace)
    window.addEventListener('newbro-delete-active-workspace', onDeleteWorkspace)
    return () => {
      window.removeEventListener('newbro-open-import-workspaces', onImport)
      window.removeEventListener('newbro-open-export-workspaces', onExport)
      window.removeEventListener('newbro-rename-active-profile', onRenameProfile)
      window.removeEventListener('newbro-delete-active-profile', onDeleteProfile)
      window.removeEventListener('newbro-rename-active-workspace', onRenameWorkspace)
      window.removeEventListener('newbro-delete-active-workspace', onDeleteWorkspace)
    }
  }, [])

  return (
    <>
      <div
        className="flex items-center gap-2 h-12 border-b border-border bg-toolbar shrink-0"
        style={{
          paddingLeft: isMac ? 80 : 8,
          paddingRight: isMac ? 8 : 142,
          paddingTop: 10,
          paddingBottom: 10,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
      >
        {/* App menu */}
        <AppMenu sidebarVisible={sidebarVisible} onToggleSidebar={onToggleSidebar} onOpenSettings={onOpenSettings} onOpenAbout={onOpenAbout} onOpenSearch={onOpenSearch} />

        {/* Profile selector */}
        <Dropdown
          items={profiles.map((p) => ({ id: p.id, name: p.name }))}
          value={activeProfileId}
          onChange={handleProfileSelect}
          onDelete={handleDeleteProfile}
          onEdit={handleEditProfile}
          canDelete={profiles.length > 1}
          iconName="User"
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
          iconName="Layout"
          label="Workspace"
          onNew={openWorkspaceDialog}
          newLabel="New Workspace"
          actions={[
            { id: 'import-workspace', label: 'Import Workspace', iconName: 'Import', onClick: handleImportWorkspace },
            { id: 'export-workspace', label: 'Export Workspaces', iconName: 'Upload', onClick: handleExportWorkspace, disabled: (activeProfile?.workspaces.length || 0) === 0 },
          ]}
        />

        <div className="w-px h-5 bg-border shrink-0" />

        {/* Search Everything */}
        <button
          onClick={onOpenSearch}
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={`Search Everything (${isMac ? '⌘' : 'Ctrl'}+O)`}
        >
          <Search size={15} />
        </button>

        {/* Downloads — opens a detached panel with active + recent downloads.
            A small dot in the corner signals downloads in progress so the user
            can spot activity even when the panel isn't open. */}
        <button
          onClick={() => setDownloadsPanelOpen((v) => !v)}
          className="relative h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={activeDownloads > 0 ? `${activeDownloads} active download${activeDownloads === 1 ? '' : 's'}` : 'Downloads'}
        >
          <DownloadIcon size={15} />
          {activeDownloads > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold leading-[14px] text-center pointer-events-none"
              aria-label={`${activeDownloads} active downloads`}
            >
              {activeDownloads > 9 ? '9+' : activeDownloads}
            </span>
          )}
        </button>

        {/* Nav buttons */}
        <button
          onClick={handleBack}
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ChevronLeft size={16} />
        </button>
        {canGoForward && (
          <button
            onClick={handleForward}
            className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title="Forward"
          >
            <ChevronRight size={16} />
          </button>
        )}
        <button
          onClick={handleReloadOrStop}
          className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md bg-secondary hover:bg-muted text-secondary-foreground"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={isLoading ? 'Stop loading' : 'Reload page'}
        >
          {isLoading ? <X size={14} /> : <RotateCw size={14} />}
        </button>

        {/* Install-from-store badge. Appears only when the active tab is a
            CWS or Edge Add-ons detail page, giving users a one-click path
            that doesn't rely on the stores' own install buttons (which
            both stores block when the browser isn't Chrome/Edge). */}
        <StoreInstallBadge activeTabUrl={activeTab?.url} />

        {/* URL bar with security indicator + tab title */}
        <div
          className="flex-[5] min-w-0 flex items-center h-8 rounded-md bg-secondary hover:bg-muted focus-within:bg-background"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {security !== 'internal' && (<>
            <button
              className={
                security === 'warning'
                  ? 'ml-1.5 h-6 px-2 flex items-center gap-1 rounded-md bg-red-600 text-white cursor-pointer group relative hover:bg-red-700'
                  : 'ml-1.5 h-6 w-6 flex items-center justify-center rounded-md bg-card cursor-pointer group relative'
              }
              onClick={() => setCertPopupOpen((v) => !v)}
            >
              {security === 'secure' && <Lock size={13} className="text-secondary-foreground" />}
              {security === 'insecure' && <Unlock size={13} className="text-muted-foreground" />}
              {security === 'warning' && (
                <>
                  <ShieldAlert size={13} />
                  <span className="text-xs font-semibold leading-none">Not secure</span>
                </>
              )}
              {/* Tooltip centered under icon (hidden when popup is open) */}
              {!certPopupOpen && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 hidden group-hover:block z-50 pointer-events-none">
                  <div className="whitespace-nowrap px-3 py-1.5 rounded-md shadow-lg text-xs font-medium border bg-popover border-border text-popover-foreground">
                    {certInfo}
                  </div>
                </div>
              )}
            </button>
            <div className="w-px h-full ml-1.5 bg-card" />
          </>)}
          <input
            id="url-bar"
            ref={urlRef}
            type="text"
            value={urlValue}
            onChange={handleUrlChange}
            onKeyDown={handleUrlKeyDown}
            onFocus={() => {
              // Mark the address bar as active so background tab.url syncs
              // don't clobber whatever the user is typing. Cleared on blur.
              setAutoActive(true)
              typedRef.current = urlValue
            }}
            onBlur={(e) => {
              // Browsers keep the visual selection highlight on a blurred
              // input (just dimmed). Collapse the selection to position 0
              // so the URL bar reads as plain unselected text once focus
              // moves away — matches typical address-bar behavior.
              try { e.currentTarget.setSelectionRange(0, 0) }
              catch (err) { console.warn('Toolbar: url onBlur setSelectionRange threw:', err) }
              // Clear autocomplete state on blur so the URL bar revisits
              // the active tab's URL on next focus / activeTab change.
              setAutoActive(false)
              if (suggestion) {
                // Drop the auto-appended suffix back to just what the user
                // actually typed; otherwise the next time we sync from
                // activeTab.url we'd briefly show a stale suggestion.
                setUrlValue(typedRef.current)
                setSuggestion(null)
              }
            }}
            placeholder="Enter URL or search..."
            spellCheck={false}
            className="flex-1 h-full px-2.5 bg-transparent border-none text-sm text-foreground outline-none"
          />
        </div>

        {/* Tab title */}
        {activeTab?.title && (<>
          <div className="w-px h-5 bg-border shrink-0 hidden min-[1200px]:block" />
          <ActiveTabTitle title={activeTab.title} favicon={activeTab.favicon} comment={activeTab.comment} />
        </>)}

        {/* Extensions cluster sits at the far right of the toolbar (after
            the tab-title chip) so it doesn't compete with the URL bar for
            space. A leading "Manage extensions" button opens Settings →
            Extensions; the pinned extension icons follow it. Click an icon
            to toggle its popup; right-click for a Chrome-style context menu. */}
        <ExtensionActions activeTabId={activeTabId} onManageExtensions={onManageExtensions} />
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

      <ImportWorkspaceDialog
        open={importDialogOpen}
        candidates={importCandidates}
        onConfirm={handleImportConfirm}
        onCancel={() => { setImportDialogOpen(false); setImportCandidates([]) }}
      />

      <ExportWorkspaceDialog
        open={exportDialogOpen}
        workspaces={activeProfile?.workspaces || []}
        profileName={activeProfile?.name}
        onConfirm={handleExportConfirm}
        onCancel={() => setExportDialogOpen(false)}
      />

      {certPopupOpen && (
        <CertificatePopup
          open={certPopupOpen}
          url={activeTab?.url || ''}
          security={security}
          onClose={() => setCertPopupOpen(false)}
        />
      )}

      <DownloadsPanel open={downloadsPanelOpen} onClose={() => setDownloadsPanelOpen(false)} />
    </>
  )
}
