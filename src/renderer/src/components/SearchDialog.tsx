import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import { log } from '../lib/log'
import { fuzzyFilter } from '../lib/fuzzy'
import { Search, User, Layout, Layers, Globe, ArrowUpDown, CornerDownLeft, Asterisk } from 'lucide-react'
import type { SearchableItem } from '../store/types'
import { DetachedWindow } from './DetachedWindow'
import { TabFavicon } from './TabFavicon'
import { CommentChip } from './CommentChip'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  windowWorkspaceId: string | null
}

const TYPE_ICONS: Record<string, typeof User> = {
  profile: User,
  workspace: Layout,
  tabGroup: Layers,
  tab: Globe,
}

const TYPE_LABELS: Record<string, string> = {
  profile: 'Profiles',
  workspace: 'Workspaces',
  tabGroup: 'Tab Groups',
  tab: 'Tabs',
}

const FILTER_TYPES = ['profile', 'workspace', 'tabGroup', 'tab'] as const

type FilterType = (typeof FILTER_TYPES)[number]

/** Exclusive filter selection — 'all' or exactly one item type. */
type FilterSelection = 'all' | FilterType

/** Where tab groups / tabs are searched: every workspace or only the one this window shows. */
type SearchScope = 'all' | 'current'

const FILTER_STORAGE_KEY = 'newbro-search-filter'
const SCOPE_STORAGE_KEY = 'newbro-search-scope'

function loadFilter(): FilterSelection {
  const raw = localStorage.getItem(FILTER_STORAGE_KEY)
  if (raw === 'all' || (FILTER_TYPES as readonly string[]).includes(raw ?? '')) {
    return raw as FilterSelection
  }
  return 'all'
}

function saveFilter(filter: FilterSelection) {
  localStorage.setItem(FILTER_STORAGE_KEY, filter)
}

function loadScope(): SearchScope {
  // Default to the window's own workspace — searching tabs/groups usually means
  // "find something in what I'm looking at" rather than across every profile.
  return localStorage.getItem(SCOPE_STORAGE_KEY) === 'all' ? 'all' : 'current'
}

function saveScope(scope: SearchScope) {
  localStorage.setItem(SCOPE_STORAGE_KEY, scope)
}

function SearchBreadcrumb({ item }: { item: SearchableItem }) {
  const visibleUrl = item.url && item.url !== 'about:blank' ? item.url : undefined
  const fullLabel = `${item.path}${visibleUrl ? ` · ${visibleUrl}` : ''}`

  return (
    <div className="text-[10px] text-muted-foreground truncate" title={fullLabel}>
      {item.pathSegments.map((segment, index) => (
        <span key={`${segment.type}-${index}`}>
          {index > 0 && <span aria-hidden="true"> &gt; </span>}
          {segment.type === 'tabGroup' && item.groupColor ? (
            <span
              data-group-pill=""
              className="inline rounded-sm px-1 font-medium"
            >
              {segment.label}
            </span>
          ) : segment.label}
        </span>
      ))}
      {visibleUrl && ` · ${visibleUrl}`}
    </div>
  )
}

const isMac = navigator.platform.includes('Mac')
const MOD = isMac ? '⌘' : 'Ctrl+'

export function SearchDialog({ open, onOpenChange, windowWorkspaceId }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filter, setFilter] = useState<FilterSelection>(loadFilter)
  const [scope, setScope] = useState<SearchScope>(loadScope)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const getAllSearchableItems = useAppStore((s) => s.getAllSearchableItems)
  const setActiveTab = useAppStore((s) => s.setActiveTab)

  // The workspace scope narrows item types that live inside a workspace
  // (tabs / tab groups) down to the window's own workspace. It's an explicit,
  // user-controlled toggle (Tab), so we honour it both while BROWSING (empty
  // query) and while TYPING a search — "This workspace" must mean this workspace
  // in both cases, otherwise typing a single character silently throws the
  // toggle away. To search a tab across every workspace (e.g. "jj" → a tab under
  // the "Jenkins Jobs" workspace from elsewhere), flip the toggle to
  // "All workspaces".
  const scopeApplies = filter === 'tabGroup' || filter === 'tab'
  const scopedToCurrent = scopeApplies && scope === 'current' && !!windowWorkspaceId

  const items = useMemo(() => {
    const all = getAllSearchableItems()
    const typed = filter === 'all' ? all : all.filter((item) => item.type === filter)
    if (scopedToCurrent) {
      return typed.filter((item) => item.workspaceId === windowWorkspaceId)
    }
    return typed
  }, [getAllSearchableItems, open, filter, scopedToCurrent, windowWorkspaceId])

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 250)
    return fuzzyFilter(query, items, (item) => {
      // Combined haystack so queries can subsequence across path + url + comment
      // (path already contains profile > workspace > group > title).
      const haystack = [item.path, item.url, item.comment]
        .filter((s): s is string => !!s && s !== 'about:blank')
        .join(' ')
      return [
        { value: item.name, weight: 1 },
        { value: item.comment, weight: 0.9 },
        { value: item.url, weight: 0.5 },
        // The path carries the profile > workspace > group context. Weight it
        // high enough that matching a tab purely by its workspace/group name
        // (e.g. "jj" → "Jenkins Jobs") surfaces the tab prominently, not buried
        // beneath weak title coincidences.
        { value: item.path, weight: 0.7 },
        { value: haystack, weight: 0.5 },
      ]
    })
  }, [query, items])

  // Count totals per type within the active scope (not just visible results)
  const allItems = useMemo(() => getAllSearchableItems(), [getAllSearchableItems, open])
  const totalCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of allItems) {
      if (scopedToCurrent && item.workspaceId !== windowWorkspaceId) continue
      counts[item.type] = (counts[item.type] || 0) + 1
    }
    return counts
  }, [allItems, scopedToCurrent, windowWorkspaceId])

  const grouped = useMemo(() => {
    const groups: Record<string, SearchableItem[]> = {}
    for (const item of results) {
      if (!groups[item.type]) groups[item.type] = []
      groups[item.type].push(item)
    }
    return groups
  }, [results])

  const flatResults = useMemo(() => {
    const flat: SearchableItem[] = []
    for (const type of FILTER_TYPES) {
      if (grouped[type]) flat.push(...grouped[type])
    }
    return flat
  }, [grouped])

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query, filter, scope])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const selectFilter = useCallback((selection: FilterSelection) => {
    setFilter(selection)
    saveFilter(selection)
    // Chip clicks move focus to the button; pull it back so typing and the
    // filter hotkeys keep working. No-op when invoked from the keyboard.
    inputRef.current?.focus()
  }, [])

  const toggleScope = useCallback(() => {
    setScope((prev) => {
      const next = prev === 'all' ? 'current' : 'all'
      saveScope(next)
      return next
    })
    inputRef.current?.focus()
  }, [])

  const handleSelect = useCallback(async (item: SearchableItem) => {
    log.action('search:select', { type: item.type, id: item.id, name: item.name })

    if (item.type === 'profile') {
      const profiles = useAppStore.getState().profiles
      const profile = profiles.find((p) => p.id === item.profileId)
      if (profile && profile.workspaces.length > 0) {
        await saveStateNow()
        // If any window of this profile is already open, focus the
        // most-recently-active one; otherwise open exactly one workspace —
        // the last used (falling back to the first).
        const byId = new Map(profile.workspaces.map((w) => [w.id, w]))
        const openWindows = await window.electronAPI.getOpenWorkspaceWindows()
        const openWs = openWindows
          .map((entry) => byId.get(entry.workspaceId))
          .find((w) => w !== undefined)
        if (openWs) {
          window.electronAPI.openWorkspaceWindow(profile.id, openWs.id, openWs.name)
        } else {
          const lastUsedId = await window.electronAPI.getLastUsedWorkspace(profile.id)
          const ws = (lastUsedId && byId.get(lastUsedId)) || profile.workspaces[0]
          window.electronAPI.openWorkspaceWindow(profile.id, ws.id, ws.name)
        }
      }
    } else if (item.type === 'workspace') {
      await saveStateNow()
      window.electronAPI.openWorkspaceWindow(item.profileId, item.workspaceId!, item.name)
    } else if (item.type === 'tabGroup') {
      const profiles = useAppStore.getState().profiles
      const profile = profiles.find((p) => p.id === item.profileId)
      const workspace = profile?.workspaces.find((w) => w.id === item.workspaceId)
      const group = workspace?.tabGroups.find((g) => g.id === item.tabGroupId)
      const firstTabId = group?.tabs[0]?.id

      if (item.workspaceId === windowWorkspaceId) {
        if (firstTabId) setActiveTab(firstTabId)
      } else {
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(
          item.profileId,
          item.workspaceId!,
          workspace?.name || item.name,
          firstTabId,
        )
      }
    } else if (item.type === 'tab') {
      if (item.workspaceId === windowWorkspaceId) {
        setActiveTab(item.id)
      } else {
        const profiles = useAppStore.getState().profiles
        const workspace = profiles
          .find((p) => p.id === item.profileId)
          ?.workspaces.find((w) => w.id === item.workspaceId)
        await saveStateNow()
        window.electronAPI.openWorkspaceWindow(
          item.profileId,
          item.workspaceId!,
          workspace?.name || item.name,
          item.id,
        )
      }
    }
    onOpenChange(false)
  }, [windowWorkspaceId, setActiveTab, onOpenChange])

  function codeToDigit(code: string): number | null {
    const m = code.match(/^Digit(\d)$/)
    return m ? parseInt(m[1], 10) : null
  }

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Filter hotkeys: ⌘ on Mac, Ctrl on Windows/Linux. Excluding the other
    // platform's modifier (incl. Alt on Windows) keeps AltGr (Ctrl+Alt) out.
    const mod = isMac ? e.metaKey : e.ctrlKey
    const otherMod = isMac ? e.altKey || e.ctrlKey : e.metaKey || e.altKey

    if (mod && !otherMod) {
      const digit = codeToDigit(e.code)
      if (digit !== null && digit >= 1 && digit <= FILTER_TYPES.length) {
        e.preventDefault()
        selectFilter(FILTER_TYPES[digit - 1])
        return
      }
      if (e.code === 'KeyR') {
        e.preventDefault()
        selectFilter('all')
        return
      }
    }

    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      // Keep focus in the search input; Tab is the scope toggle here.
      e.preventDefault()
      if (scopeApplies) toggleScope()
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, flatResults.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flatResults[selectedIndex]) handleSelect(flatResults[selectedIndex])
    } else if (e.key === 'Escape') {
      onOpenChange(false)
    }
  }, [flatResults, selectedIndex, handleSelect, onOpenChange, selectFilter, toggleScope, scopeApplies])

  if (!open) return null

  let flatIdx = 0

  return (
    <DetachedWindow
      open={open}
      title="Search - Newbro"
      width={760}
      height={640}
      closeOnBlur
      onClose={() => onOpenChange(false)}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <span className="w-6 shrink-0 flex items-center">
            <Search size={16} className="text-muted-foreground" />
          </span>
          <input
            data-detached-drag-handle
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search everything..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0">
          <button
            onClick={() => selectFilter('all')}
            className={`flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
              filter === 'all'
                ? 'bg-primary/20 text-primary border border-primary/30'
                : 'bg-secondary text-muted-foreground border border-transparent hover:bg-accent'
            }`}
          >
            <Asterisk size={10} />
            All
            <span className="opacity-50 ml-0.5">{MOD}R</span>
          </button>
          {FILTER_TYPES.map((type, i) => {
            const Icon = TYPE_ICONS[type]
            const active = filter === type
            return (
              <button
                key={type}
                onClick={() => selectFilter(type)}
                className={`flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-secondary text-muted-foreground border border-transparent hover:bg-accent'
                }`}
              >
                <Icon size={10} />
                {TYPE_LABELS[type]}
                <span className="opacity-50 ml-0.5">{MOD}{i + 1}</span>
              </button>
            )
          })}
          {scopeApplies && (
            <button
              onClick={toggleScope}
              title="Toggle search scope (Tab)"
              role="switch"
              aria-checked={scope === 'current'}
              className="ml-auto flex items-center gap-1.5 h-6 px-2 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              {scope === 'current' ? 'This workspace' : 'All workspaces'}
              <span
                className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full px-0.5 transition-colors ${
                  scope === 'current' ? 'bg-primary' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${
                    scope === 'current' ? 'translate-x-[10px]' : 'translate-x-0'
                  }`}
                />
              </span>
              <span className="opacity-50">⇥</span>
            </button>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto min-h-0">
          {flatResults.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results found
            </div>
          ) : (
            FILTER_TYPES.map((type) => {
              const groupItems = grouped[type]
              if (!groupItems || groupItems.length === 0) return null
              const TypeIcon = TYPE_ICONS[type] || Globe
              const visibleCount = groupItems.length
              const totalCount = totalCounts[type] || visibleCount
              const countLabel = query.trim() ? `${visibleCount}/${totalCount}` : `${totalCount}`
              return (
                <div key={type}>
                  <div className="px-4 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <span className="w-6 shrink-0" />
                    <span className="flex-1 flex items-center gap-1"><TypeIcon size={10} /> {TYPE_LABELS[type] || type}</span>
                    <span className="w-8 text-right">{countLabel}</span>
                  </div>
                  {groupItems.map((item) => {
                    const idx = flatIdx++
                    return (
                      <div
                        key={item.id}
                        data-index={idx}
                        data-group-container={item.groupColor ? '' : undefined}
                        style={item.groupColor ? { ['--gc' as string]: item.groupColor } : undefined}
                        className={`flex items-center gap-2 px-4 py-2 cursor-pointer ${
                          idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        }`}
                        onClick={() => handleSelect(item)}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <span className="relative w-6 shrink-0 flex items-center">
                          {item.type === 'tab' ? (
                            <>
                              {item.groupColor && (
                                <span
                                  aria-hidden="true"
                                  className="absolute -left-1 h-4 w-0.5 rounded-full"
                                  style={{ backgroundColor: 'var(--gc-resolved)' }}
                                />
                              )}
                              <TabFavicon favicon={item.favicon} />
                            </>
                          ) : (
                            <TypeIcon
                              size={16}
                              className="text-muted-foreground/60"
                              style={item.type === 'tabGroup' && item.groupColor
                                ? { color: 'var(--gc-resolved)' }
                                : undefined}
                            />
                          )}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {item.comment && <CommentChip comment={item.comment} />}
                            <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>
                              {item.name}
                            </span>
                          </div>
                          <SearchBreadcrumb item={item} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <div
          data-detached-drag-handle
          className="h-10 px-4 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">Navigate <kbd><ArrowUpDown size={11} strokeWidth={2.5} /></kbd></span>
            <span className="flex items-center gap-1">Open <kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd></span>
            <span className="flex items-center gap-1">Filter <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>1…4</kbd></span>
            <span className="flex items-center gap-1">All <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>R</kbd></span>
            {scopeApplies && (
              <span className="flex items-center gap-1">Scope <kbd>Tab</kbd></span>
            )}
          </div>
          <span className="flex items-center gap-1">Close <kbd>Esc</kbd></span>
        </div>
      </div>
    </DetachedWindow>
  )
}
