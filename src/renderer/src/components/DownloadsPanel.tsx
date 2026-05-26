// Detached panel showing in-flight and historical downloads.
//
// Source of truth lives in the main process (src/main/downloads.ts); this
// component subscribes to broadcast snapshots over IPC and renders them.
// Per-row actions (pause/resume/cancel/remove/show-in-folder/open-file)
// all go through the preload API, which round-trips to main.
//
// Layout note: each row uses three stacked sub-rows (info → meta → progress
// bar). The progress bar is full-width below everything so its state-driven
// color is the only thing that moves on state transitions — there's no
// horizontal label whose width-shift would jiggle the rest of the row.
// `tabular-nums` is used on all numeric strings to lock digit width.

import { useEffect, useState, useMemo } from 'react'
import {
  Download as DownloadIcon, X, Folder, FolderOpen, Pause, Play,
  Trash2, Link2, Check,
} from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import type { DownloadEntry, DownloadState } from '../App'

interface Props {
  open: boolean
  onClose: () => void
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  const fixed = v >= 100 || v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)
  return `${fixed} ${units[i]}`
}

function formatSpeed(bps: number | undefined): string | null {
  if (!bps || bps <= 0) return null
  return `${formatBytes(bps)}/s`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

// Progress-bar color follows the lifecycle state. Completed shows a full
// green bar so users can scan the list and spot successes at a glance;
// cancelled / interrupted bars stop at whatever percent was reached and
// are tinted muted / destructive respectively.
function progressBarClass(state: DownloadState): string {
  switch (state) {
    case 'completed':   return 'bg-green-500'
    case 'progressing': return 'bg-primary'
    case 'paused':      return 'bg-muted-foreground'
    case 'interrupted': return 'bg-destructive'
    case 'cancelled':   return 'bg-muted-foreground/60'
  }
}

function stateLabel(state: DownloadState): string {
  switch (state) {
    case 'completed':   return 'Completed'
    case 'progressing': return 'Downloading'
    case 'paused':      return 'Paused'
    case 'interrupted': return 'Interrupted'
    case 'cancelled':   return 'Cancelled'
  }
}

// Width of the action column, fixed so the count of currently-applicable
// buttons (varies per state) doesn't change the row's horizontal layout
// underneath. Sized for the largest combination — 4 buttons × 28px +
// 3 gaps × 4px = 124px.
const ACTION_COL_WIDTH = 124

function Row({ entry, onAction }: {
  entry: DownloadEntry
  onAction: (id: string, action: 'pause' | 'resume' | 'cancel' | 'remove' | 'show' | 'open' | 'copy') => void
}) {
  // Briefly swap the copy icon for a check after the click so the user
  // gets immediate feedback that the URL is on their clipboard.
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  const isLive = entry.state === 'progressing' || entry.state === 'paused'
  const percent = entry.totalBytes > 0
    ? Math.min(100, Math.max(0, Math.round((entry.receivedBytes / entry.totalBytes) * 100)))
    : (entry.state === 'completed' ? 100 : 0)
  const speed = entry.state === 'progressing' ? formatSpeed(entry.bytesPerSecond) : null
  const openable = entry.state === 'completed'

  // Build the meta line as discrete segments joined by " · " so we can keep
  // it on one truncating line. Numbers carry tabular-nums via the parent.
  const metaParts: string[] = [stateLabel(entry.state)]
  if (isLive) {
    metaParts.push(`${percent}%`)
    if (entry.totalBytes > 0) metaParts.push(`${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.totalBytes)}`)
    else metaParts.push(formatBytes(entry.receivedBytes))
    if (speed) metaParts.push(speed)
  } else if (entry.state === 'completed') {
    metaParts.push(formatBytes(entry.totalBytes || entry.receivedBytes))
    metaParts.push(formatRelative(entry.endedAt || entry.startedAt))
  } else {
    // cancelled / interrupted — show how far we got so the row stays informative.
    if (entry.totalBytes > 0) metaParts.push(`${percent}%`)
    metaParts.push(formatRelative(entry.endedAt || entry.startedAt))
  }

  return (
    <div
      className={
        'group px-3 py-2.5 border-b border-border last:border-b-0 ' +
        (openable ? 'cursor-pointer hover:bg-accent/40' : '')
      }
      onClick={openable ? () => onAction(entry.id, 'open') : undefined}
      title={openable ? `Open ${entry.filename}` : undefined}
    >
      {/* Row 1: filename (truncating) + fixed-width action column */}
      <div className="flex items-center gap-3">
        <div className="text-sm font-medium text-foreground truncate flex-1 min-w-0" title={entry.filename}>
          {entry.filename}
        </div>
        <div
          className="shrink-0 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ width: ACTION_COL_WIDTH }}
        >
          {entry.state === 'progressing' && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'pause') }}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Pause"
            ><Pause size={13} /></button>
          )}
          {entry.state === 'paused' && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'resume') }}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Resume"
            ><Play size={13} /></button>
          )}
          {isLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'cancel') }}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Cancel"
            ><X size={13} /></button>
          )}
          {entry.state === 'completed' && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'open') }}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Open file"
            ><FolderOpen size={13} /></button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'show') }}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            title="Show in folder"
          ><Folder size={13} /></button>
          <button
            onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'copy'); setCopied(true) }}
            className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            title={copied ? 'Copied!' : 'Copy link'}
          >{copied ? <Check size={13} className="text-green-500" /> : <Link2 size={13} />}</button>
          {!isLive && (
            <button
              onClick={(e) => { e.stopPropagation(); onAction(entry.id, 'remove') }}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-destructive"
              title="Remove from list"
            ><Trash2 size={13} /></button>
          )}
        </div>
      </div>

      {/* Row 2: origin URL (lighter, single line) */}
      <div className="text-[11px] text-muted-foreground truncate mt-0.5" title={entry.originUrl || entry.url}>
        {entry.originUrl || entry.url}
      </div>

      {/* Row 3: meta line (state + size + speed). Numbers use tabular-nums so
          their width doesn't jump as values grow. */}
      <div className="text-[11px] text-muted-foreground truncate mt-1.5" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {metaParts.join(' · ')}
      </div>

      {/* Row 4: full-width progress bar — state-driven color is the only
          thing that moves on transitions. */}
      <div className="mt-1.5 h-1 bg-secondary rounded-full overflow-hidden w-full">
        <div
          className={'h-full transition-[width] ' + progressBarClass(entry.state)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export function DownloadsPanel({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DownloadEntry[]>([])

  useEffect(() => {
    if (!open) return
    let alive = true
    void window.electronAPI.downloadsList?.().then((list) => {
      if (!alive) return
      setEntries(list || [])
    })
    const cleanup = window.electronAPI.onDownloadsUpdated?.((list) => {
      setEntries(list || [])
    })
    return () => { alive = false; cleanup?.() }
  }, [open])

  const { activeCount, hasFinished } = useMemo(() => {
    let a = 0
    let f = false
    for (const e of entries) {
      if (e.state === 'progressing' || e.state === 'paused') a++
      else f = true
    }
    return { activeCount: a, hasFinished: f }
  }, [entries])

  const handleAction = (id: string, action: 'pause' | 'resume' | 'cancel' | 'remove' | 'show' | 'open' | 'copy') => {
    const api = window.electronAPI
    switch (action) {
      case 'pause':  void api.downloadsPause?.(id); break
      case 'resume': void api.downloadsResume?.(id); break
      case 'cancel': void api.downloadsCancel?.(id); break
      case 'remove': void api.downloadsRemove?.(id); break
      case 'show':   void api.downloadsShowInFolder?.(id); break
      case 'open':   void api.downloadsOpenFile?.(id); break
      case 'copy': {
        // Reach into entries via id rather than threading the URL through —
        // keeps the action protocol uniform (just an id). Route through main's
        // clipboard module via IPC: navigator.clipboard.writeText fails
        // silently from a DetachedWindow popup because the parent renderer
        // document isn't the focused document at click time.
        const entry = entries.find((e) => e.id === id)
        if (!entry) break
        api.clipboardWriteText(entry.url)
        break
      }
    }
  }

  const handleClearFinished = () => {
    void window.electronAPI.downloadsClear?.()
  }

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Downloads"
      width={620}
      height={560}
      onClose={onClose}
      closeOnBlur
      persistKey="downloads-panel"
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        {/* Fixed header height so the row doesn't grow when the conditional
            Clear button appears. The button itself is h-7 (28px), the close
            button is h-6 (24px) — without a locked height the header would
            jump by 4px every time history transitions between empty and
            non-empty. items-center keeps everything vertically centered. */}
        <div
          className="h-12 flex items-center justify-between px-4 border-b border-border shrink-0"
          data-detached-drag-handle
        >
          <div className="flex items-center gap-2">
            <DownloadIcon size={16} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">
              Downloads
              {activeCount > 0 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {activeCount} active
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-1" data-detached-no-drag>
            {hasFinished && (
              <button
                onClick={handleClearFinished}
                className="h-7 px-2 flex items-center gap-1 rounded-md hover:bg-muted text-xs text-muted-foreground hover:text-foreground"
                title="Clear finished downloads"
              >
                <Trash2 size={12} />
                Clear
              </button>
            )}
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" data-detached-no-drag>
          {entries.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-muted-foreground px-6 text-center">
              <DownloadIcon size={28} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">No downloads yet</div>
              <div className="text-xs mt-1 opacity-75">Files you download will appear here.</div>
            </div>
          ) : (
            entries.map((e) => (<Row key={e.id} entry={e} onAction={handleAction} />))
          )}
        </div>
      </div>
    </DetachedWindow>
  )
}
