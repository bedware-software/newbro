import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, X, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'

type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; version: string }
  | { phase: 'available'; version: string; releaseNotes?: string | null }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string; releaseNotes?: string | null }
  | { phase: 'error'; message: string }

/**
 * Floating update notification — shows at the bottom-right of the window
 * when an update is available, downloading, ready to install, or errored.
 * Invisible in the idle / checking / not-available phases so it doesn't
 * nag users on every app open.
 */
export function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const initialStatusRef = useRef<UpdateStatus | null>(null)

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return

    // Remember the initial status at mount time. We don't want to show the
    // banner for a stale "not-available" left over from the startup check
    // — only for phases that came in *after* we mounted (i.e. user actions
    // or live updater events).
    api.getUpdaterStatus?.().then((s: UpdateStatus) => {
      initialStatusRef.current = s ?? { phase: 'idle' }
      if (s) setStatus(s)
    })

    const cleanup = api.onUpdaterStatus?.((s: UpdateStatus) => {
      setStatus(s)
    })
    return cleanup
  }, [])

  // Reset dismissal when the phase changes, so a new update event can
  // re-show the banner even if the user closed a previous one.
  useEffect(() => {
    setDismissed((prev) => (prev === status.phase ? prev : null))
  }, [status.phase])

  // Auto-dismiss the transient "up to date" toast after a few seconds so
  // the user sees confirmation of their click but isn't left with a
  // lingering banner.
  useEffect(() => {
    if (status.phase !== 'not-available') return
    const id = setTimeout(() => setDismissed('not-available'), 4000)
    return () => clearTimeout(id)
  }, [status.phase])

  // Skip the stale startup "not-available" that predates the user's first
  // interaction — we only want to flash it when the phase transitions live.
  const isStaleInitial =
    initialStatusRef.current?.phase === status.phase &&
    (status.phase === 'not-available' || status.phase === 'idle')

  const visible =
    !isStaleInitial && (
      status.phase === 'checking' ||
      status.phase === 'not-available' ||
      status.phase === 'available' ||
      status.phase === 'downloading' ||
      status.phase === 'downloaded' ||
      status.phase === 'error'
    )

  if (!visible) return null
  if (dismissed === status.phase) return null

  const api = (window as any).electronAPI

  if (status.phase === 'checking') {
    return (
      <Shell onClose={() => setDismissed(status.phase)}>
        <Loader2 size={16} className="text-muted-foreground shrink-0 animate-spin" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Checking for updates…</div>
        </div>
      </Shell>
    )
  }

  if (status.phase === 'not-available') {
    return (
      <Shell onClose={() => setDismissed(status.phase)}>
        <CheckCircle2 size={16} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">You're up to date</div>
          <div className="text-[11px] text-muted-foreground">Running v{status.version}</div>
        </div>
      </Shell>
    )
  }

  if (status.phase === 'error') {
    return (
      <Shell onClose={() => setDismissed(status.phase)}>
        <AlertTriangle size={16} className="text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Update check failed</div>
          <div className="text-[11px] text-muted-foreground truncate" title={status.message}>
            {status.message}
          </div>
        </div>
      </Shell>
    )
  }

  if (status.phase === 'available') {
    return (
      <Shell onClose={() => setDismissed(status.phase)}>
        <Download size={16} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Update available</div>
          <div className="text-[11px] text-muted-foreground">
            v{status.version} — downloading…
          </div>
        </div>
      </Shell>
    )
  }

  if (status.phase === 'downloading') {
    return (
      <Shell onClose={() => setDismissed(status.phase)}>
        <Download size={16} className="text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">Downloading update</div>
          <div className="mt-1 h-1 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, status.percent))}%` }}
            />
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            v{status.version} · {status.percent}%
          </div>
        </div>
      </Shell>
    )
  }

  // downloaded
  return (
    <Shell onClose={() => setDismissed(status.phase)}>
      <CheckCircle2 size={16} className="text-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">Update ready</div>
        <div className="text-[11px] text-muted-foreground">
          v{status.version} will install on quit, or restart now.
        </div>
      </div>
      <button
        onClick={() => api.installUpdate?.()}
        className="flex items-center gap-1 h-7 px-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/80 text-xs font-medium shrink-0"
      >
        <RefreshCw size={12} />
        Restart
      </button>
    </Shell>
  )
}

/**
 * The banner docks at the bottom of the webview column in normal flow rather
 * than floating `position: fixed`. Tabs render as native WebContentsViews that
 * composite ABOVE the renderer DOM, so a fixed overlay over the page area gets
 * hidden (and, with the bookshelf open, visibly clipped at its edge). Sitting
 * in flow shrinks the tab view's measured rect instead, keeping the card fully
 * visible — the same trick the permission infobar and find bar use.
 */
function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }): JSX.Element {
  return (
    <div className="shrink-0 w-full flex justify-end bg-background px-3 pb-3 pt-1">
      <div className="w-80 max-w-full bg-popover border border-border rounded-lg shadow-lg p-3 flex items-start gap-2">
        {children}
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
