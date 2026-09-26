// Downloads page (newbro://downloads) — a full tab, like Chrome's
// chrome://downloads, in place of the old detached popup. It's an internal
// page (lib/internal-pages.ts): WebviewPanel draws it over the page area.
//
// The list itself lives in main (src/main/downloads.ts); we mirror its
// broadcasts and sort / filter locally. Every action is on the keyboard — see
// KEY_HELP (shown with `?`); the footer advertises the common keys.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Download as DownloadIcon, File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo,
  Folder, FolderOpen, Link2, Pause, Play, RotateCw, Search, Trash2, X, Keyboard,
  ArrowDownWideNarrow, ArrowUpNarrowWide, type LucideIcon,
} from 'lucide-react'
import type { DownloadEntry } from '../App'
import { useAppStore } from '../store/app-store'
import { isVimNavActive } from '../lib/vim-nav'
import { openDropdownAsync, type DropdownAction } from './dropdown-protocol'

type SortKey = 'date' | 'size' | 'name'
type SortDir = 'asc' | 'desc'
interface SortState {
  key: SortKey
  dir: SortDir
}

const SORT_KEYS: SortKey[] = ['date', 'size', 'name']
const SORT_LABELS: Record<SortKey, string> = { date: 'Date', size: 'Size', name: 'Name' }
// Picking a sort starts from its natural direction: newest, largest, A→Z.
const DEFAULT_DIR: Record<SortKey, SortDir> = { date: 'desc', size: 'desc', name: 'asc' }
const SORT_STORAGE_KEY = 'newbro-downloads-sort'

// How long the second `g` of `gg` may trail the first (same as vim-nav).
const GG_TIMEOUT_MS = 1000

/** Events other parts of the app send the page: App routes find-in-page and
 *  reload here while the Downloads tab is active. */
export const DOWNLOADS_FIND_EVENT = 'newbro-downloads-find'
export const DOWNLOADS_RELOAD_EVENT = 'newbro-downloads-reload'

const KEY_HELP: Array<[string, string]> = [
  ['j / k, ↓ / ↑', 'Move through the list'],
  ['gg / G, Home / End', 'First / last download'],
  ['Enter', 'Main action: open, resume or retry'],
  ['o', 'Open file'],
  ['f', 'Show in folder'],
  ['c', 'Copy download link'],
  ['Space', 'Pause or resume'],
  ['r', 'Retry a failed download'],
  ['x, Delete', 'Cancel, or remove from list'],
  ['X', 'Clear all finished downloads'],
  ['s / S', 'Next sort / reverse order'],
  ['/', 'Search downloads'],
  ['m', 'All actions for the selected download'],
  ['O', 'Open the downloads folder'],
  ['?', 'Show or hide this help'],
]

function loadSort(): SortState {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || 'null') as Partial<SortState> | null
    if (v && SORT_KEYS.includes(v.key as SortKey) && (v.dir === 'asc' || v.dir === 'desc')) {
      return { key: v.key as SortKey, dir: v.dir }
    }
  } catch {
    /* corrupt entry — fall back to the default */
  }
  return { key: 'date', dir: 'desc' }
}

function saveSort(sort: SortState): void {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort)) } catch { /* storage unavailable */ }
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

function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`
  const min = Math.round(seconds / 60)
  if (min < 60) return `${min} min left`
  const h = Math.floor(min / 60)
  return `${h} h ${min % 60} min left`
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** "Today" / "Yesterday" / "September 24, 2026" — Chrome's day headings. */
function dayLabel(ms: number): string {
  const now = new Date()
  if (dayKey(ms) === dayKey(now.getTime())) return 'Today'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (dayKey(ms) === dayKey(yesterday.getTime())) return 'Yesterday'
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function timeLabel(ms: number, withDate: boolean): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (!withDate) return time
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

function hostOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).host || url } catch { return url }
}

const isLive = (e: DownloadEntry): boolean => e.state === 'progressing' || e.state === 'paused'
const sizeOf = (e: DownloadEntry): number => (e.totalBytes > 0 ? e.totalBytes : e.receivedBytes)
const isDeleted = (e: DownloadEntry): boolean => e.state === 'completed' && e.fileExists === false
const canOpen = (e: DownloadEntry): boolean => e.state === 'completed' && e.fileExists !== false
const canRetry = (e: DownloadEntry): boolean => e.state === 'cancelled' || e.state === 'interrupted'
// A running download's folder is worth opening too; a failed one left no file.
const canShow = (e: DownloadEntry): boolean => canOpen(e) || isLive(e)

function percentOf(e: DownloadEntry): number {
  if (e.totalBytes > 0) return Math.min(100, Math.max(0, Math.round((e.receivedBytes / e.totalBytes) * 100)))
  return e.state === 'completed' ? 100 : 0
}

/** One line under the filename: what's happening, or what happened. Empty
 *  for a finished download still on disk — its size sits in the right column. */
function statusLine(e: DownloadEntry): string {
  switch (e.state) {
    case 'progressing': {
      const parts = [e.totalBytes > 0
        ? `${formatBytes(e.receivedBytes)} of ${formatBytes(e.totalBytes)}`
        : formatBytes(e.receivedBytes)]
      if (e.bytesPerSecond && e.bytesPerSecond > 0) {
        parts.push(`${formatBytes(e.bytesPerSecond)}/s`)
        if (e.totalBytes > e.receivedBytes) parts.push(formatTimeLeft((e.totalBytes - e.receivedBytes) / e.bytesPerSecond))
      }
      return parts.join(' · ')
    }
    case 'paused':
      return `Paused · ${e.totalBytes > 0 ? `${percentOf(e)}% of ${formatBytes(e.totalBytes)}` : formatBytes(e.receivedBytes)}`
    case 'completed':
      return isDeleted(e) ? 'Deleted' : ''
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
  }
}

const EXT_ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/i, FileArchive],
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|avif|tiff?)$/i, FileImage],
  [/\.(mp4|mkv|mov|avi|webm|m4v|wmv)$/i, FileVideo],
  [/\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i, FileAudio],
  [/\.(js|ts|tsx|jsx|json|py|sh|ps1|rb|go|rs|java|c|cpp|h|css|html?|xml|ya?ml)$/i, FileCode],
  [/\.(pdf|txt|md|rtf|docx?|xlsx?|pptx?|odt|csv|epub)$/i, FileText],
]

// OS file icons for completed downloads, fetched once per entry and shared
// across page instances (every window's Downloads tab).
const osIcons = new Map<string, string | null>()

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
}

/** Win keyboard focus back for the renderer after a popup (the actions menu)
 *  closes: the OS may hand it to the hidden tab view first. Same retry the
 *  vim-mode panels use. */
function reclaimRendererFocus(): void {
  window.electronAPI?.reclaimWindowRendererFocus?.()
  for (const delay of [60, 180]) {
    setTimeout(() => {
      if (!document.hasFocus()) window.electronAPI?.reclaimWindowRendererFocus?.()
    }, delay)
  }
}

function readThemeAttrs(): { theme?: string; themeVariant?: string } {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'item'; key: string; entry: DownloadEntry }

export function DownloadsPage() {
  const [entries, setEntries] = useState<DownloadEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [sort, setSort] = useState<SortState>(loadSort)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [, setIconTick] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingGRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activePartition = useAppStore((s) => s.getActivePartition())

  useEffect(() => { saveSort(sort) }, [sort])

  // Mirror main's list. Listing again whenever the window regains focus
  // re-checks which files still exist (deleted in Explorer / Finder meanwhile).
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.electronAPI.downloadsList?.().then((list) => {
        if (!alive) return
        setEntries(list || [])
        setLoaded(true)
      })
    }
    load()
    const cleanup = window.electronAPI.onDownloadsUpdated?.((list) => setEntries(list || []))
    window.addEventListener('focus', load)
    window.addEventListener(DOWNLOADS_RELOAD_EVENT, load)
    return () => {
      alive = false
      cleanup?.()
      window.removeEventListener('focus', load)
      window.removeEventListener(DOWNLOADS_RELOAD_EVENT, load)
    }
  }, [])

  // Fetch OS icons for completed files we haven't asked about yet.
  useEffect(() => {
    for (const e of entries) {
      if (!canOpen(e) || osIcons.has(e.id)) continue
      osIcons.set(e.id, null)
      void window.electronAPI.downloadsFileIcon?.(e.id).then((icon) => {
        if (!icon) return
        osIcons.set(e.id, icon)
        setIconTick((n) => n + 1)
      })
    }
  }, [entries])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? entries.filter((e) =>
          e.filename.toLowerCase().includes(q) ||
          e.url.toLowerCase().includes(q) ||
          (e.originUrl ?? '').toLowerCase().includes(q))
      : entries.slice()
    const sign = sort.dir === 'asc' ? 1 : -1
    matched.sort((a, b) => {
      let cmp = 0
      if (sort.key === 'size') cmp = sizeOf(a) - sizeOf(b)
      else if (sort.key === 'name') cmp = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' })
      else cmp = a.startedAt - b.startedAt
      // Ties (same size, same name) fall back to newest first.
      return cmp !== 0 ? cmp * sign : b.startedAt - a.startedAt
    })
    return matched
  }, [entries, query, sort])

  // Date sort reads best under day headings, the way Chrome groups its page.
  const rows = useMemo(() => {
    const out: Row[] = []
    let lastDay = ''
    for (const e of visible) {
      if (sort.key === 'date') {
        const key = dayKey(e.startedAt)
        if (key !== lastDay) {
          out.push({ kind: 'day', key: `day-${key}`, label: dayLabel(e.startedAt) })
          lastDay = key
        }
      }
      out.push({ kind: 'item', key: e.id, entry: e })
    }
    return out
  }, [visible, sort.key])

  // The cursor stays on its download while the list re-sorts; when that
  // download is filtered out or removed it falls back to the first row.
  const selected = visible.find((e) => e.id === selectedId) ?? visible[0] ?? null

  useEffect(() => {
    if (!selected) return
    listRef.current
      ?.querySelector(`[data-download-id="${CSS.escape(selected.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id])

  // Take the keyboard when the page opens — unless a panel in vim mode is
  // stepping through tabs, or the user is typing somewhere (the URL bar).
  useEffect(() => {
    if (isVimNavActive()) return
    if (isEditable(document.activeElement)) return
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const showFlash = useCallback((msg: string) => {
    setFlash(msg)
  }, [])
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(t)
  }, [flash])

  const focusList = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const focusSearch = useCallback(() => {
    const input = searchRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    window.addEventListener(DOWNLOADS_FIND_EVENT, focusSearch)
    return () => window.removeEventListener(DOWNLOADS_FIND_EVENT, focusSearch)
  }, [focusSearch])

  // ── actions ──
  const api = window.electronAPI
  const open = (e: DownloadEntry): void => {
    if (!canOpen(e)) {
      if (isDeleted(e)) showFlash('The file was deleted')
      return
    }
    void api.downloadsOpenFile?.(e.id).then((ok) => { if (!ok) showFlash('Could not open the file') })
  }
  const showInFolder = (e: DownloadEntry): void => {
    if (canShow(e)) void api.downloadsShowInFolder?.(e.id)
  }
  const copyLink = (e: DownloadEntry): void => {
    api.clipboardWriteText(e.url)
    showFlash('Download link copied')
  }
  const togglePause = (e: DownloadEntry): void => {
    if (e.state === 'progressing') void api.downloadsPause?.(e.id)
    else if (e.state === 'paused') void api.downloadsResume?.(e.id)
  }
  const retry = (e: DownloadEntry): void => {
    if (!canRetry(e)) return
    void api.downloadsRetry?.(e.id, activePartition)
  }
  /** x: an active download is cancelled first; a finished one leaves the
   *  list, the cursor moving on to what follows it (vim's x). */
  const removeOrCancel = (e: DownloadEntry): void => {
    if (isLive(e)) {
      void api.downloadsCancel?.(e.id)
      return
    }
    const at = visible.findIndex((v) => v.id === e.id)
    const next = visible[at + 1] ?? visible[at - 1]
    setSelectedId(next?.id ?? null)
    void api.downloadsRemove?.(e.id)
  }
  const clearFinished = (): void => {
    if (!entries.some((e) => !isLive(e))) return
    void api.downloadsClear?.()
    showFlash('Finished downloads cleared')
  }
  const openFolder = (): void => {
    void api.downloadsOpenFolder?.()
  }
  /** Enter / double-click: whatever the row's highlighted button does. */
  const primary = (e: DownloadEntry): void => {
    if (isLive(e)) togglePause(e)
    else if (canRetry(e)) retry(e)
    else open(e)
  }

  const moveBy = (delta: number): void => {
    if (visible.length === 0) return
    const at = selected ? visible.indexOf(selected) : -1
    const next = visible[Math.max(0, Math.min(visible.length - 1, at + delta))]
    if (next) setSelectedId(next.id)
  }
  const moveTo = (index: number): void => {
    const target = index < 0 ? visible[visible.length - 1] : visible[index]
    if (target) setSelectedId(target.id)
  }
  const pageSize = (): number => {
    const list = listRef.current
    const row = list?.querySelector('[data-download-id]') as HTMLElement | null
    if (!list || !row) return 10
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight) - 1)
  }

  const cycleSort = (): void => {
    setSort((s) => {
      const key = SORT_KEYS[(SORT_KEYS.indexOf(s.key) + 1) % SORT_KEYS.length]
      return { key, dir: DEFAULT_DIR[key] }
    })
  }
  const reverseSort = (): void => {
    setSort((s) => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))
  }
  /** Clicking the active sort flips its direction; another switches to it. */
  const pickSort = (key: SortKey): void => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }))
  }

  const openMenu = async (e: DownloadEntry, at: { x: number; y: number }, keyboard: boolean): Promise<void> => {
    const actions: DropdownAction[] = []
    if (canOpen(e)) actions.push({ id: 'open', label: 'Open', iconName: 'FolderOpen', shortcut: ['o'] })
    if (canShow(e)) actions.push({ id: 'show', label: 'Show in Folder', iconName: 'Folder', shortcut: ['f'] })
    actions.push({ id: 'copy', label: 'Copy Download Link', iconName: 'Link', shortcut: ['c'] })
    if (e.state === 'progressing') actions.push({ id: 'pause', label: 'Pause', iconName: 'Pause', shortcut: ['Space'], divider: 'before' })
    if (e.state === 'paused') actions.push({ id: 'resume', label: 'Resume', iconName: 'Play', shortcut: ['Space'], divider: 'before' })
    if (isLive(e)) actions.push({ id: 'cancel', label: 'Cancel Download', iconName: 'X', shortcut: ['x'] })
    if (canRetry(e)) actions.push({ id: 'retry', label: 'Retry', iconName: 'RotateCw', shortcut: ['r'], divider: 'before' })
    if (!isLive(e)) actions.push({ id: 'remove', label: 'Remove from List', iconName: 'Trash2', shortcut: ['x'], destructive: true, divider: canRetry(e) ? undefined : 'before' })
    actions.push({ id: 'clear', label: 'Clear All Finished', iconName: 'ListX', shortcut: ['Shift', 'X'], divider: 'before', disabled: !entries.some((x) => !isLive(x)) })
    actions.push({ id: 'folder', label: 'Open Downloads Folder', iconName: 'FolderOpen', shortcut: ['Shift', 'O'] })

    const result = await openDropdownAsync({
      kind: 'menu',
      position: at,
      ...readThemeAttrs(),
      header: e.filename,
      actions,
      ...(keyboard ? { keyboard: true } : {}),
    })
    if (keyboard) {
      reclaimRendererFocus()
      focusList()
    }
    if (!result || result.type !== 'action') return
    switch (result.actionId) {
      case 'open': open(e); break
      case 'show': showInFolder(e); break
      case 'copy': copyLink(e); break
      case 'pause':
      case 'resume': togglePause(e); break
      case 'cancel': void api.downloadsCancel?.(e.id); break
      case 'retry': retry(e); break
      case 'remove': removeOrCancel(e); break
      case 'clear': clearFinished(); break
      case 'folder': openFolder(); break
    }
  }

  const openMenuForSelected = (): void => {
    if (!selected) return
    const row = listRef.current?.querySelector(`[data-download-id="${CSS.escape(selected.id)}"]`)
    if (!row) return
    const rect = row.getBoundingClientRect()
    void openMenu(selected, { x: rect.left + 48, y: rect.bottom }, true)
  }

  // ── keyboard ──
  // Registered once; the ref always points at this render's handler so the
  // keys act on the current list, sort and selection.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  onKeyRef.current = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return
    const root = rootRef.current
    if (!root) return
    // Only while the page has the keyboard: focus on it, or on nothing at all.
    const target = e.target
    const onPage = target === document.body || target === document.documentElement ||
      (target instanceof Node && root.contains(target))
    if (!onPage || isEditable(target)) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    // A focused control (Tab onto a header button) keeps its own Enter / Space.
    if ((e.key === 'Enter' || e.key === ' ') && target instanceof HTMLElement && target.closest('button, a, [role="radio"]')) return

    if (e.key === 'Escape' && helpOpen) {
      e.preventDefault()
      e.stopPropagation()
      setHelpOpen(false)
      return
    }

    let handled = true
    if (e.key === 'g' && !e.shiftKey) {
      if (pendingGRef.current) {
        clearTimeout(pendingGRef.current)
        pendingGRef.current = null
        moveTo(0)
      } else {
        pendingGRef.current = setTimeout(() => { pendingGRef.current = null }, GG_TIMEOUT_MS)
      }
      e.preventDefault()
      return
    }
    if (pendingGRef.current) {
      clearTimeout(pendingGRef.current)
      pendingGRef.current = null
    }
    switch (e.key) {
      case 'j':
      case 'ArrowDown': moveBy(1); break
      case 'k':
      case 'ArrowUp': moveBy(-1); break
      case 'Home': moveTo(0); break
      case 'G':
      case 'End': moveTo(-1); break
      case 'PageDown': moveBy(pageSize()); break
      case 'PageUp': moveBy(-pageSize()); break
      case '/': focusSearch(); break
      case 's': cycleSort(); break
      case 'S': reverseSort(); break
      case '?': setHelpOpen((v) => !v); break
      case 'O': openFolder(); break
      case 'X': clearFinished(); break
      case 'ContextMenu': openMenuForSelected(); break
      case 'F10':
        if (e.shiftKey) openMenuForSelected()
        else handled = false
        break
      default:
        handled = false
    }
    if (!handled && selected) {
      handled = true
      switch (e.key) {
        case 'Enter': primary(selected); break
        case 'o': open(selected); break
        case 'f': showInFolder(selected); break
        case 'c':
        case 'y': copyLink(selected); break
        case ' ':
        case 'p': togglePause(selected); break
        case 'r': retry(selected); break
        case 'x':
        case 'Delete':
        case 'Backspace': removeOrCancel(selected); break
        case 'm': openMenuForSelected(); break
        default: handled = false
      }
    }
    if (!handled) return
    e.preventDefault()
    // Keeps App's global Escape / other window listeners out of keys we used.
    e.stopPropagation()
  }
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => onKeyRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (pendingGRef.current) clearTimeout(pendingGRef.current)
    }
  }, [])

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault()
      if (visible[0]) setSelectedId(visible[0].id)
      focusList()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery('')
      else focusList()
    }
  }

  const activeCount = entries.filter(isLive).length
  const hasFinished = entries.some((e) => !isLive(e))
  const summary = entries.length === 0
    ? ''
    : `${entries.length} ${entries.length === 1 ? 'download' : 'downloads'}${activeCount > 0 ? ` · ${activeCount} active` : ''}`

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
      role="region"
      aria-label="Downloads"
    >
      {/* Header: title + global actions, then search and sort. */}
      <div className="shrink-0 border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 pt-5 pb-3">
          <DownloadIcon size={18} className="text-primary shrink-0" />
          <h1 className="text-lg font-semibold tracking-tight">Downloads</h1>
          {summary && <span className="text-xs text-muted-foreground tabular-nums">{summary}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={openFolder}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="Open the downloads folder (O)"
            >
              <FolderOpen size={14} />
              Open folder
            </button>
            <button
              onClick={clearFinished}
              disabled={!hasFinished}
              className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title="Remove every finished download from the list (Shift+X). Files stay on disk."
            >
              <Trash2 size={14} />
              Clear all
            </button>
          </div>
        </div>
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 pb-4">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search downloads"
              spellCheck={false}
              className="h-9 w-full rounded-md border border-input bg-secondary pl-9 pr-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:bg-background"
            />
            {query ? (
              <button
                onClick={() => { setQuery(''); focusSearch() }}
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear search (Esc)"
                tabIndex={-1}
              >
                <X size={13} />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">/</kbd>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Sort by</span>
            <div className="flex h-9 items-center rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="Sort downloads">
              {SORT_KEYS.map((key) => {
                const active = sort.key === key
                return (
                  <button
                    key={key}
                    role="radio"
                    aria-checked={active}
                    onClick={() => pickSort(key)}
                    className={`flex h-8 items-center gap-1 rounded px-2.5 text-xs font-medium transition-colors ${
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={active ? 'Reverse the order (Shift+S)' : `Sort by ${SORT_LABELS[key].toLowerCase()} (S cycles)`}
                  >
                    {SORT_LABELS[key]}
                    {active && (sort.dir === 'desc'
                      ? <ArrowDownWideNarrow size={13} />
                      : <ArrowUpNarrowWide size={13} />)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto max-w-4xl px-4 py-3"
          role="listbox"
          aria-label="Downloads"
          aria-activedescendant={selected ? `download-${selected.id}` : undefined}
        >
          {loaded && entries.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
              <DownloadIcon size={30} className="mb-3 opacity-50" />
              <p className="text-sm font-medium text-foreground">No downloads yet</p>
              <p className="mt-1 text-xs">Files you download will appear here.</p>
            </div>
          )}
          {entries.length > 0 && visible.length === 0 && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No downloads match “{query.trim()}”.
            </p>
          )}
          {rows.map((row) =>
            row.kind === 'day' ? (
              <div
                key={row.key}
                className="px-3 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:pt-1"
              >
                {row.label}
              </div>
            ) : (
              <DownloadRow
                key={row.key}
                entry={row.entry}
                selected={row.entry.id === selected?.id}
                showDate={sort.key !== 'date'}
                osIcon={osIcons.get(row.entry.id) ?? null}
                onSelect={() => { setSelectedId(row.entry.id); focusList() }}
                onPrimary={() => primary(row.entry)}
                onOpen={() => open(row.entry)}
                onShow={() => showInFolder(row.entry)}
                onCopy={() => copyLink(row.entry)}
                onTogglePause={() => togglePause(row.entry)}
                onRetry={() => retry(row.entry)}
                onRemove={() => removeOrCancel(row.entry)}
                onContextMenu={(at) => { setSelectedId(row.entry.id); void openMenu(row.entry, at, false) }}
              />
            ),
          )}
        </div>
      </div>

      {/* Footer: the common keys, or a short confirmation after an action. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-4 border-t border-border bg-toolbar px-4 text-[11px] font-medium text-muted-foreground">
        {flash ? (
          <span className="text-foreground">{flash}</span>
        ) : (
          <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
            <span className="flex items-center gap-1">Navigate <kbd>j</kbd><kbd>k</kbd></span>
            <span className="flex items-center gap-1">Open <kbd>Enter</kbd></span>
            <span className="flex items-center gap-1">Folder <kbd>f</kbd></span>
            <span className="flex items-center gap-1">Copy link <kbd>c</kbd></span>
            <span className="flex items-center gap-1">Remove <kbd>x</kbd></span>
            <span className="flex items-center gap-1">Sort <kbd>s</kbd></span>
            <span className="flex items-center gap-1">Search <kbd>/</kbd></span>
            <span className="flex items-center gap-1">Actions <kbd>m</kbd></span>
          </div>
        )}
        <button
          onClick={() => setHelpOpen((v) => !v)}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground"
          title="Keyboard shortcuts (?)"
          tabIndex={-1}
        >
          <Keyboard size={13} />
          <kbd>?</kbd>
        </button>
      </div>

      {helpOpen && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-background/70 backdrop-blur-[1px]"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-[420px] max-w-[90%] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
              <button
                onClick={() => setHelpOpen(false)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close keyboard shortcuts"
              >
                <X size={13} />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              {KEY_HELP.map(([keys, what]) => (
                <div key={keys} className="contents">
                  <dt className="font-mono text-foreground">{keys}</dt>
                  <dd className="text-muted-foreground">{what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}

function FileTypeIcon({ entry, osIcon }: { entry: DownloadEntry; osIcon: string | null }) {
  if (osIcon && !isDeleted(entry)) {
    return <img src={osIcon} alt="" draggable={false} className="h-8 w-8 shrink-0 object-contain" />
  }
  const Icon = EXT_ICONS.find(([re]) => re.test(entry.filename))?.[1] ?? File
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
      <Icon size={16} />
    </div>
  )
}

function DownloadRow({
  entry, selected, showDate, osIcon,
  onSelect, onPrimary, onOpen, onShow, onCopy, onTogglePause, onRetry, onRemove, onContextMenu,
}: {
  entry: DownloadEntry
  selected: boolean
  showDate: boolean
  osIcon: string | null
  onSelect: () => void
  onPrimary: () => void
  onOpen: () => void
  onShow: () => void
  onCopy: () => void
  onTogglePause: () => void
  onRetry: () => void
  onRemove: () => void
  onContextMenu: (at: { x: number; y: number }) => void
}) {
  const live = isLive(entry)
  const openable = canOpen(entry)
  const struck = entry.state === 'cancelled' || isDeleted(entry)
  const failed = entry.state === 'interrupted'
  const percent = percentOf(entry)
  const source = entry.originUrl || entry.url
  const status = statusLine(entry)
  const iconButton = 'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'

  return (
    <div
      id={`download-${entry.id}`}
      data-download-id={entry.id}
      role="option"
      aria-selected={selected}
      // Keep focus on the page (not the clicked button) so the keys keep
      // driving the list; clicks still land on the row's buttons.
      onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); onSelect() } }}
      onDoubleClick={onPrimary}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu({ x: e.clientX, y: e.clientY }) }}
      className={`group relative flex items-center gap-3 rounded-lg py-2.5 pl-4 pr-2 transition-colors ${
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40'
      }`}
    >
      {selected && <span className="pointer-events-none absolute bottom-2 left-1 top-2 w-[3px] rounded-full bg-primary" />}
      <FileTypeIcon entry={entry} osIcon={osIcon} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onOpen() }}
            disabled={!openable}
            tabIndex={-1}
            className={`min-w-0 truncate text-left text-sm font-medium ${
              struck ? 'text-muted-foreground line-through' : 'text-foreground'
            } ${openable ? 'hover:underline' : 'cursor-default'}`}
            title={openable ? `Open ${entry.filename}` : entry.filename}
          >
            {entry.filename}
          </button>
          {failed && (
            <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-px text-[10px] font-semibold text-destructive">Failed</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={source} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {hostOf(source)}
          {status && (
            <>
              <span className="mx-1.5 opacity-60">·</span>
              {status}
            </>
          )}
        </div>
        {live && (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full transition-[width] ${entry.state === 'paused' ? 'bg-muted-foreground' : 'bg-primary'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </div>

      <div className="w-24 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
        {!live && <div>{formatBytes(sizeOf(entry))}</div>}
        <div>{timeLabel(entry.startedAt, showDate)}</div>
      </div>

      {/* Row actions: always shown on the cursor row, on hover elsewhere.
          Out of the Tab order — the keys above reach every one of them. */}
      <div className={`flex w-[124px] shrink-0 items-center justify-end gap-0.5 ${
        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}>
        {entry.state === 'progressing' && (
          <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onTogglePause() }} className={iconButton} title="Pause (Space)">
            <Pause size={14} />
          </button>
        )}
        {entry.state === 'paused' && (
          <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onTogglePause() }} className={iconButton} title="Resume (Space)">
            <Play size={14} />
          </button>
        )}
        {canRetry(entry) && (
          <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onRetry() }} className={iconButton} title="Retry (R)">
            <RotateCw size={14} />
          </button>
        )}
        {openable && (
          <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onOpen() }} className={iconButton} title="Open (O)">
            <FolderOpen size={14} />
          </button>
        )}
        {canShow(entry) && (
          <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onShow() }} className={iconButton} title="Show in folder (F)">
            <Folder size={14} />
          </button>
        )}
        <button tabIndex={-1} onClick={(e) => { e.stopPropagation(); onCopy() }} className={iconButton} title="Copy download link (C)">
          <Link2 size={14} />
        </button>
        <button
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          className={`${iconButton} hover:text-destructive`}
          title={live ? 'Cancel (X)' : 'Remove from list (X)'}
        >
          {live ? <X size={14} /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  )
}
