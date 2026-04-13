import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Layers, Plus } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { DetachedWindow } from './DetachedWindow'

interface Props {
  open: boolean
  onClose: () => void
  onSelect: (groupId: string) => void
  onNewGroup: () => void
}

export function GroupPicker({ open, onClose, onSelect, onNewGroup }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)

  const groups = useMemo(() => {
    const profile = profiles.find((p) => p.id === activeProfileId)
    const workspace = profile?.workspaces.find((w) => w.id === activeWorkspaceId)
    return workspace?.tabGroups || []
  }, [profiles, activeProfileId, activeWorkspaceId])

  const filtered = useMemo(() => {
    if (!query.trim()) return groups
    const q = query.toLowerCase()
    return groups.filter((g) => g.name.toLowerCase().includes(q))
  }, [groups, query])

  // +1 for the "New Group" option at the end
  const totalItems = filtered.length + 1

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, totalItems - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selectedIndex < filtered.length) {
        onSelect(filtered[selectedIndex].id)
      } else {
        onNewGroup()
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }, [filtered, selectedIndex, totalItems, onSelect, onNewGroup, onClose])

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Move to Group - Newbro"
      width={400}
      height={380}
      onClose={onClose}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <Layers size={16} className="text-muted-foreground shrink-0" />
          <input
            data-detached-drag-handle
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search groups..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.map((group, idx) => {
            const isSelected = idx === selectedIndex
            return (
              <div
                key={group.id}
                data-selected={isSelected}
                className={`flex items-center gap-2.5 px-4 py-1.5 cursor-pointer text-sm ${
                  isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                }`}
                onClick={() => onSelect(group.id)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
                <span>{group.name}</span>
                <span className="text-xs text-muted-foreground ml-auto">{group.tabs.length} tabs</span>
              </div>
            )
          })}

          <div className="h-px bg-border my-1" />

          <div
            data-selected={selectedIndex === filtered.length}
            className={`flex items-center gap-2.5 px-4 py-1.5 cursor-pointer text-sm ${
              selectedIndex === filtered.length ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
            }`}
            onClick={onNewGroup}
            onMouseEnter={() => setSelectedIndex(filtered.length)}
          >
            <Plus size={14} className="text-muted-foreground shrink-0" />
            <span>New Group...</span>
          </div>

          {filtered.length === 0 && (
            <div className="px-4 py-4 text-center text-xs text-muted-foreground">
              No groups found
            </div>
          )}
        </div>

        <div
          data-detached-drag-handle
          className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex gap-3 shrink-0"
        >
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </DetachedWindow>
  )
}
