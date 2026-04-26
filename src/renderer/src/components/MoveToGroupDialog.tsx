import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, ArrowUpDown, CornerDownLeft } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'

interface GroupOption {
  id: string
  name: string
  // CSS color string (e.g. "#a855f7"). Renders as the same colored dot the
  // sidebar uses next to each group header so the two surfaces stay visually
  // consistent — picking from this list maps 1:1 to what's on screen.
  color: string
}

interface Props {
  open: boolean
  // Shown in the dialog's header so the user can confirm what they're moving.
  tabTitle?: string
  // Candidate destinations — typically the workspace's tab groups minus the
  // tab's current group. Empty list disables confirmation (the dialog still
  // opens so the empty state is visible).
  groups: GroupOption[]
  onConfirm: (groupId: string) => void
  onCancel: () => void
}

// Cheap fuzzy-ish ranking: substring beats subsequence; word-start matches
// rank higher within each tier. Mirrors the CommandPalette algorithm so the
// two pickers feel the same to the user.
function rank(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const idx = t.indexOf(q)
  if (idx !== -1) return 1000 - idx * 2 + (idx === 0 ? 50 : 0)
  const isWordStart = (i: number): boolean => i === 0 || /[\s\-_]/.test(t[i - 1])
  let score = 0
  let qi = 0
  let lastMatchIdx = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    let charScore = 1
    if (isWordStart(ti)) charScore += 10
    if (ti === lastMatchIdx + 1) charScore += 5
    score += charScore
    lastMatchIdx = ti
    qi++
  }
  return qi === q.length ? score : 0
}

export function MoveToGroupDialog({ open, tabTitle, groups, onConfirm, onCancel }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state every time the dialog re-opens; otherwise stale
  // search text from a previous invocation lingers.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return groups
    return groups
      .map((g) => ({ g, score: rank(query, g.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.g)
  }, [query, groups])

  // Reset highlight to top whenever the result set changes.
  useEffect(() => { setSelectedIndex(0) }, [query])

  // Keep the highlighted row visible while arrow-keying through a long list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = filtered[selectedIndex]
      if (picked) onConfirm(picked.id)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  if (!open) return null

  return (
    <DetachedWindow open={open} title="Move to Group" width={460} height={420} resizable={false} onClose={onCancel}>
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            data-detached-no-drag
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Find group…"
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {tabTitle && (
          <div className="px-4 py-1.5 border-b border-border text-[11px] text-muted-foreground truncate shrink-0">
            Moving <span className="text-foreground font-medium">{tabTitle}</span>
          </div>
        )}

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.map((g, idx) => {
            const isSelected = idx === selectedIndex
            return (
              <div
                key={g.id}
                data-selected={isSelected}
                className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm ${
                  isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                }`}
                onClick={() => onConfirm(g.id)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: g.color }}
                />
                <span className="truncate">{g.name}</span>
              </div>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {groups.length === 0 ? 'No other groups in this workspace' : 'No matches'}
            </div>
          )}
        </div>

        <div
          data-detached-drag-handle
          className="h-10 px-3 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">Navigate <kbd><ArrowUpDown size={11} strokeWidth={2.5} /></kbd></span>
            <span className="flex items-center gap-1">Move <kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd></span>
          </div>
          <span className="flex items-center gap-1">Close <kbd>Esc</kbd></span>
        </div>
      </div>
    </DetachedWindow>
  )
}
