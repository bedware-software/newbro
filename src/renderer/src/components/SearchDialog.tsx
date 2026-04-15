import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import { log } from '../lib/log'
import { fuzzyFilter } from '../lib/fuzzy'
import { Search, User, Layout, Layers, Globe } from 'lucide-react'
import type { SearchableItem } from '../store/types'
import { DetachedWindow } from './DetachedWindow'

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

const STORAGE_KEY = 'newbro-search-filters'

function loadFilters(): Set<FilterType> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return new Set(JSON.parse(raw) as FilterType[])
  } catch {
    // ignore invalid local state
  }
  return new Set(FILTER_TYPES)
}

function saveFilters(filters: Set<FilterType>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...filters]))
}

const isMac = navigator.platform.includes('Mac')
const OPT = isMac ? '\u2325' : 'Alt+'

export function SearchDialog({ open, onOpenChange, windowWorkspaceId }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [filters, setFilters] = useState<Set<FilterType>>(loadFilters)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const getAllSearchableItems = useAppStore((s) => s.getAllSearchableItems)
  const setActiveTab = useAppStore((s) => s.setActiveTab)

  const items = useMemo(() => {
    const all = getAllSearchableItems()
    return all.filter((item) => filters.has(item.type as FilterType))
  }, [getAllSearchableItems, open, filters])

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 250)
    return fuzzyFilter(query, items, (item) => [
      { value: item.name, weight: 1 },
      { value: item.comment, weight: 0.9 },
      { value: item.url, weight: 0.5 },
      { value: item.path, weight: 0.3 },
    ])
  }, [query, items])

  // Count totals per type from all items (not just visible results)
  const allItems = useMemo(() => getAllSearchableItems(), [getAllSearchableItems, open])
  const totalCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of allItems) counts[item.type] = (counts[item.type] || 0) + 1
    return counts
  }, [allItems])

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
  }, [query, filters])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const toggleFilter = useCallback((type: FilterType) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        if (next.size === 1) return prev
        next.delete(type)
      } else {
        next.add(type)
      }
      saveFilters(next)
      return next
    })
  }, [])

  const handleSelect = useCallback(async (item: SearchableItem) => {
    log.action('search:select', { type: item.type, id: item.id, name: item.name })

    if (item.type === 'profile') {
      const profiles = useAppStore.getState().profiles
      const profile = profiles.find((p) => p.id === item.profileId)
      if (profile) {
        await saveStateNow()
        for (const ws of profile.workspaces) {
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
    const digit = codeToDigit(e.code)

    if (e.altKey && !e.metaKey && !e.ctrlKey && digit !== null) {
      if (digit >= 1 && digit <= FILTER_TYPES.length) {
        e.preventDefault()
        toggleFilter(FILTER_TYPES[digit - 1])
        return
      }
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
  }, [flatResults, selectedIndex, handleSelect, onOpenChange, toggleFilter])

  if (!open) return null

  let flatIdx = 0

  return (
    <DetachedWindow
      open={open}
      title="Search - Newbro"
      width={760}
      height={640}
      onClose={() => onOpenChange(false)}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <Search size={16} className="text-muted-foreground shrink-0" />
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
          {FILTER_TYPES.map((type, i) => {
            const Icon = TYPE_ICONS[type]
            const active = filters.has(type)
            return (
              <button
                key={type}
                onClick={() => toggleFilter(type)}
                className={`flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-secondary text-muted-foreground border border-transparent hover:bg-accent'
                }`}
              >
                <Icon size={10} />
                {TYPE_LABELS[type]}
                <span className="opacity-50 ml-0.5">{OPT}{i + 1}</span>
              </button>
            )
          })}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-2 min-h-0">
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
                    <span className="flex-1">{TYPE_LABELS[type] || type}</span>
                    <span className="w-8 text-right">{countLabel}</span>
                  </div>
                  {groupItems.map((item) => {
                    const idx = flatIdx++
                    return (
                      <div
                        key={item.id}
                        data-index={idx}
                        className={`flex items-center gap-2 px-4 py-2 cursor-pointer ${
                          idx === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        }`}
                        onClick={() => handleSelect(item)}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <span className="w-6 shrink-0 flex items-center">
                          <TypeIcon size={16} className="text-muted-foreground/60" />
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">
                            {item.comment ? `${item.comment} — ${item.name}` : item.name}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">
                            {item.path}
                            {item.url && item.url !== 'about:blank' && ` · ${item.url}`}
                          </div>
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
          className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex gap-3 shrink-0"
        >
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>{OPT}1-4 Toggle Filters</span>
          <span>Esc Close</span>
        </div>
      </div>
    </DetachedWindow>
  )
}
