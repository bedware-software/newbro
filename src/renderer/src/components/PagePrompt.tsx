// What a page asks of the user — a site's permission request, or (macOS) the
// system blocking what was allowed — in a popup pinned to the page area's
// top-left corner (Find in Page has the top-right one), over the page
// rather than pushing it down. It shows without taking the keyboard, so a
// site asking mid-typing doesn't cut in; Esc in it, once clicked, dismisses.

import type { ReactNode } from 'react'
import { Bell, Camera, Clipboard, MapPin, Mic, Music, ShieldAlert, X, type LucideIcon } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { usePagePlacement } from '../lib/page-placement'
import { describePermissionKinds, type PermissionKind } from '../lib/permissions'

const WIDTH = 420
// Padding (p-3), the message row (h-8, or three lines), the gap, the
// buttons (h-8) and the border.
const HEIGHT = 98
const TALL_HEIGHT = 126

interface ShellProps {
  open: boolean
  title: string
  height: number
  /** The page area: the popup sits in its top-left corner. */
  anchorRef: React.RefObject<HTMLElement | null>
  onDismiss: () => void
  children: ReactNode
}

function PagePrompt({ open, title, height, anchorRef, onDismiss, children }: ShellProps) {
  const placement = usePagePlacement(open, anchorRef, 'left', WIDTH)
  if (!open || !placement) return null
  return (
    <DetachedWindow
      open
      title={title}
      width={WIDTH}
      height={height}
      resizable={false}
      activate={false}
      placement={placement}
      onClose={onDismiss}
    >
      <div className="h-full flex flex-col justify-between gap-2 p-3 bg-popover text-popover-foreground border border-border overflow-hidden">
        {children}
      </div>
    </DetachedWindow>
  )
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      aria-label="Dismiss"
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
    >
      <X size={16} />
    </button>
  )
}

const PERMISSION_ICON: Record<PermissionKind, LucideIcon> = {
  microphone: Mic,
  camera: Camera,
  geolocation: MapPin,
  notifications: Bell,
  clipboard: Clipboard,
  midi: Music,
}

/** Chrome-style permission prompt. Allow / Block remember the choice for the
 *  site; the X (or Esc) dismisses it once, and the site can ask again. */
export function PermissionPrompt({
  open,
  origin,
  kinds,
  anchorRef,
  onDecide,
}: {
  open: boolean
  origin: string
  kinds: PermissionKind[]
  anchorRef: React.RefObject<HTMLElement | null>
  onDecide: (decision: 'allow' | 'block', remember: boolean) => void
}) {
  let host = origin
  try {
    host = new URL(origin).hostname
  } catch {
    /* malformed origin — fall back to the raw string */
  }
  const Icon = PERMISSION_ICON[kinds[0]] ?? Mic
  const dismiss = (): void => onDecide('block', false)
  return (
    <PagePrompt open={open} title="Permission - Newbro" height={HEIGHT} anchorRef={anchorRef} onDismiss={dismiss}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <p className="min-w-0 flex-1 truncate text-sm" title={`${host} wants to ${describePermissionKinds(kinds)}`}>
          <span className="font-medium">{host}</span>{' '}
          <span className="text-muted-foreground">wants to {describePermissionKinds(kinds)}</span>
        </p>
        <DismissButton onClick={dismiss} />
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={() => onDecide('block', true)}
          className="h-8 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          Block
        </button>
        <button
          onClick={() => onDecide('allow', true)}
          className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Allow
        </button>
      </div>
    </PagePrompt>
  )
}

/** Shown when the OS (macOS Privacy/TCC) blocks media even though the site was
 *  allowed in-app. The app can't grant this itself — only System Settings can —
 *  so we point the user there. */
export function OsBlockedPrompt({
  open,
  kinds,
  anchorRef,
  onOpenSettings,
  onDismiss,
}: {
  open: boolean
  kinds: PermissionKind[]
  anchorRef: React.RefObject<HTMLElement | null>
  onOpenSettings: (kind: 'microphone' | 'camera') => void
  onDismiss: () => void
}) {
  const label = kinds
    .map((k) => (k === 'camera' ? 'camera' : 'microphone'))
    .join(' and ')
  const primaryKind: 'microphone' | 'camera' = kinds.includes('camera') && !kinds.includes('microphone')
    ? 'camera'
    : 'microphone'
  return (
    <PagePrompt open={open} title="Permission - Newbro" height={TALL_HEIGHT} anchorRef={anchorRef} onDismiss={onDismiss}>
      <div className="flex items-start gap-3 min-w-0">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
          <ShieldAlert size={16} strokeWidth={1.75} />
        </div>
        <p className="min-w-0 flex-1 line-clamp-3 text-[13px] leading-snug text-muted-foreground">
          Your system is blocking Newbro from using your{' '}
          <span className="font-medium text-foreground">{label}</span>. Enable it in System Settings, then reload the page.
        </p>
        <DismissButton onClick={onDismiss} />
      </div>
      <div className="flex justify-end">
        <button
          onClick={() => onOpenSettings(primaryKind)}
          className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Open System Settings
        </button>
      </div>
    </PagePrompt>
  )
}
