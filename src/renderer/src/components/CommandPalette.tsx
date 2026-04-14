import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Command } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { useAppStore } from '../store/app-store'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction: (action: string) => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')

interface CommandItem {
  id: string
  label: string
  category: string
}

const COMMANDS: CommandItem[] = [
  { id: 'close-tab', label: 'Close', category: 'Active Tab' },
  { id: 'set-comment', label: 'Set Comment', category: 'Active Tab' },
  { id: 'remove-comment', label: 'Remove Comment', category: 'Active Tab' },
  { id: 'move-to-group', label: 'Move to Group...', category: 'Active Tab' },
  { id: 'add-to-new-group', label: 'Add to New Group...', category: 'Active Tab' },
  { id: 'new-tab', label: 'New Tab', category: 'Tabs' },
  { id: 'next-tab', label: 'Next Tab', category: 'Tabs' },
  { id: 'prev-tab', label: 'Previous Tab', category: 'Tabs' },
  { id: 'new-workspace', label: 'New Workspace', category: 'Workspaces' },
  { id: 'close-workspace', label: 'Close Workspace', category: 'Workspaces' },
  { id: 'expand-all-groups', label: 'Expand All Tab Groups', category: 'View' },
  { id: 'collapse-all-groups', label: 'Collapse All Tab Groups', category: 'View' },
  { id: 'focus-url', label: 'Focus Address Bar', category: 'Navigation' },
  { id: 'back', label: 'Navigate Back', category: 'Navigation' },
  { id: 'forward', label: 'Navigate Forward', category: 'Navigation' },
  { id: 'reload', label: 'Reload Page', category: 'Navigation' },
  { id: 'search', label: 'Search Everything', category: 'General' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'View' },
  { id: 'settings', label: 'Open Settings', category: 'General' },
  { id: 'about', label: 'About Newbro', category: 'General' },
  { id: 'close-window', label: 'Close Window', category: 'Window' },
  { id: 'quit', label: 'Quit', category: 'General' },
]

function formatKeybinding(binding: string): string {
  return binding
    .replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .replace(/\+/g, isMac ? '' : '+')
}

export function CommandPalette({ open, onOpenChange, onAction }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [keybindings, setKeybindings] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeTab = useAppStore((s) => s.getActiveTab())

  const availableCommands = useMemo(() => {
    return COMMANDS.filter((cmd) => {
      if (cmd.id === 'remove-comment') return !!activeTab?.comment
      return true
    })
  }, [activeTab?.comment])

  useEffect(() => {
    if (open) {
      setSelectedIndex(0)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      ;(window as any).electronAPI.loadSettings().then((s: any) => {
        if (s?.keybindings) setKeybindings(s.keybindings)
      })
    }
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return availableCommands
    const q = query.toLowerCase()
    return availableCommands.filter((cmd) =>
      cmd.label.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q)
    )
  }, [query])

  // Group by category
  const grouped = useMemo(() => {
    const groups: { category: string; items: CommandItem[] }[] = []
    const seen = new Set<string>()
    for (const cmd of filtered) {
      if (!seen.has(cmd.category)) {
        seen.add(cmd.category)
        groups.push({ category: cmd.category, items: [] })
      }
      groups.find((g) => g.category === cmd.category)!.items.push(cmd)
    }
    return groups
  }, [filtered])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleSelect = useCallback((cmd: CommandItem) => {
    onAction(cmd.id)
  }, [onAction])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) handleSelect(filtered[selectedIndex])
    } else if (e.key === 'Escape') {
      onOpenChange(false)
    }
  }, [filtered, selectedIndex, handleSelect, onOpenChange])

  if (!open) return null

  let flatIdx = 0

  return (
    <DetachedWindow
      open={open}
      title="Command Palette - Newbro"
      width={560}
      height={480}
      onClose={() => onOpenChange(false)}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <Command size={16} className="text-muted-foreground shrink-0" />
          <input
            data-detached-drag-handle
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {grouped.map((group) => (
            <div key={group.category}>
              <div className="px-4 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                {group.category}
              </div>
              {group.items.map((cmd) => {
                const idx = flatIdx++
                const isSelected = idx === selectedIndex
                const binding = keybindings[cmd.id] || getDefaultBinding(cmd.id)
                return (
                  <div
                    key={cmd.id}
                    data-selected={isSelected}
                    className={`flex items-center justify-between px-4 py-1.5 cursor-pointer text-sm ${
                      isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                    }`}
                    onClick={() => handleSelect(cmd)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span>{cmd.label}</span>
                    {binding && (
                      <span className="text-xs text-muted-foreground ml-4 shrink-0">
                        {formatKeybinding(binding)}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No commands found
            </div>
          )}
        </div>

        <div
          data-detached-drag-handle
          className="px-4 py-2 border-t border-border text-[10px] text-muted-foreground flex gap-3 shrink-0"
        >
          <span>↑↓ Navigate</span>
          <span>↵ Run</span>
          <span>Esc Close</span>
        </div>
      </div>
    </DetachedWindow>
  )
}

const DEFAULT_BINDINGS: Record<string, string> = {
  'new-tab': 'CmdOrCtrl+T',
  'close-tab': 'CmdOrCtrl+W',
  'close-window': 'CmdOrCtrl+Shift+W',
  'new-workspace': 'CmdOrCtrl+Shift+N',
  'next-tab': 'Alt+J',
  'prev-tab': 'Alt+K',
  'toggle-sidebar': 'CmdOrCtrl+B',
  'focus-url': 'CmdOrCtrl+L',
  'search': 'CmdOrCtrl+O',
  'command-palette': 'CmdOrCtrl+P',
  'back': 'CmdOrCtrl+[',
  'forward': 'CmdOrCtrl+]',
  'reload': 'CmdOrCtrl+R',
  'settings': 'CmdOrCtrl+,',
}

function getDefaultBinding(id: string): string | undefined {
  return DEFAULT_BINDINGS[id]
}
