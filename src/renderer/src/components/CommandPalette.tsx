import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Command, ArrowUpDown, CornerDownLeft } from 'lucide-react'
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
  { id: 'move-tab', label: 'Move Tab...', category: 'Active Tab' },
  { id: 'copy-tab', label: 'Copy Tab...', category: 'Active Tab' },
  { id: 'add-to-new-group', label: 'Add to New Group...', category: 'Active Tab' },
  { id: 'move-group', label: 'Move Group...', category: 'Active Group' },
  { id: 'copy-group', label: 'Copy Group...', category: 'Active Group' },
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
  { id: 'page-devtools', label: 'Toggle Page Developer Tools', category: 'Navigation' },
  { id: 'search', label: 'Search Everything', category: 'General' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'View' },
  { id: 'settings', label: 'Open Settings', category: 'General' },
  { id: 'about', label: 'About', category: 'General' },
  { id: 'close-window', label: 'Close Window', category: 'Window' },
  { id: 'minimize-window', label: 'Minimize', category: 'Window' },
  { id: 'maximize-window', label: 'Maximize', category: 'Window' },
  { id: 'restore-window', label: 'Restore', category: 'Window' },
  { id: 'quit', label: 'Exit', category: 'General' },
]

function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const isWordStart = (i: number) => i === 0 || /[\s\-_]/.test(t[i - 1])

  // 1. Word-start substring — query is a prefix of some word in the text.
  const idx = t.indexOf(q)
  if (idx !== -1 && isWordStart(idx)) {
    return 2000 - idx * 2 + (idx === 0 ? 100 : 0)
  }

  // 2. Acronym match — query letters are the first letters of consecutive
  //    words. Beats mid-word substring so "os" surfaces "Open Settings",
  //    and "ng" surfaces "Add to New Group..." (initials "atng" contains
  //    "ng") instead of "Open Setti[ng]s".
  if (q.length >= 2) {
    const initials = t.split(/[\s_\-]+/).filter(Boolean).map((w) => w[0]).join('')
    const ii = initials.indexOf(q)
    if (ii !== -1) {
      const exact = ii === 0 && q.length === initials.length ? 100 : 0
      return 1500 - ii * 10 + exact
    }
  }

  // 3. Substring inside a word.
  if (idx !== -1) {
    return 1000 - idx * 2
  }

  // 4. Subsequence match: all query chars must appear in order in the text.
  //    Word-boundary and consecutive-char matches are weighted higher.
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

function formatKeybinding(binding: string): React.ReactNode {
  const parts = binding
    .replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl')
    .replace(/Shift/g, isMac ? '⇧' : 'Shift')
    .replace(/Alt/g, isMac ? '⌥' : 'Alt')
    .split('+')
    .filter(Boolean)
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  )
}

export function CommandPalette({ open, onOpenChange, onAction }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [keybindings, setKeybindings] = useState<Record<string, string[]>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeTab = useAppStore((s) => s.getActiveTab())
  // Group-scoped commands need a real group to operate on. The active tab
  // group can be null when the user is on an ungrouped (Root) tab.
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId)

  const availableCommands = useMemo(() => {
    return COMMANDS.filter((cmd) => {
      if (cmd.id === 'remove-comment') return !!activeTab?.comment
      if (cmd.id === 'move-group' || cmd.id === 'copy-group') return !!activeTabGroupId
      return true
    })
  }, [activeTab?.comment, activeTabGroupId])

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
    return availableCommands
      .map((cmd) => ({
        cmd,
        score: Math.max(
          fuzzyScore(query, cmd.label),
          fuzzyScore(query, cmd.category),
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.cmd)
  }, [query, availableCommands])

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
      closeOnBlur
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
                // The palette has room for one shortcut hint per row, so we
                // surface only the first binding. The second binding still
                // works — it just doesn't get advertised here. An explicit
                // empty array (user cleared every binding) suppresses the
                // hint so we don't lie about a shortcut that won't fire.
                const userBindings = keybindings[cmd.id]
                const binding = userBindings === undefined
                  ? getDefaultBinding(cmd.id)
                  : (userBindings.length > 0 ? userBindings[0] : undefined)
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
                      <span className="text-xs text-muted-foreground ml-4 shrink-0 flex items-center">
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
          className="h-10 px-3 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">Navigate <kbd><ArrowUpDown size={11} strokeWidth={2.5} /></kbd></span>
            <span className="flex items-center gap-1">Run <kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd></span>
          </div>
          <span className="flex items-center gap-1">Close <kbd>Esc</kbd></span>
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
  'next-tab': 'CmdOrCtrl+Tab',
  'prev-tab': 'CmdOrCtrl+Shift+Tab',
  'toggle-sidebar': 'CmdOrCtrl+\\',
  'focus-url': 'CmdOrCtrl+L',
  'search': 'CmdOrCtrl+O',
  'command-palette': 'CmdOrCtrl+P',
  'back': 'CmdOrCtrl+[',
  'forward': 'CmdOrCtrl+]',
  'reload': 'CmdOrCtrl+R',
  'settings': 'CmdOrCtrl+,',
  'page-devtools': 'CmdOrCtrl+Shift+I',
}

function getDefaultBinding(id: string): string | undefined {
  return DEFAULT_BINDINGS[id]
}
