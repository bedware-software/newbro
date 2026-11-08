import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Command } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { InputField } from './InputField'
import { Hint, HintBar, LEAVE_INSERT_CAP, RowHint, vimKeyCaps } from './KeyHints'
import { hintIndex, usePopupHints } from '../lib/hint-labels'
import { useAppStore } from '../store/app-store'
import { isInternalUrl } from '../lib/internal-pages'
import { actionHint, type HintSettings } from '../lib/shortcut-hints'
import { usePopupVimMode } from '../lib/vim-mode'
import type { VimKeymap } from '../lib/vim-keymap'
import { isSplitShown, useSplitStore } from '../lib/split-view'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction: (action: string) => void
  /** The palette's COMMAND keys (Search Everything's, less its filters);
   *  null while Vim mode is off. */
  vimKeymap: VimKeymap | null
}


const isMac = navigator.platform.toLowerCase().includes('mac')

interface CommandItem {
  id: string
  label: string
  category: string
  /** Other words it's found by. */
  keywords?: string
}

const COMMANDS: CommandItem[] = [
  { id: 'close-tab', label: 'Close', category: 'Active Tab' },
  { id: 'duplicate-tab', label: 'Duplicate', category: 'Active Tab' },
  { id: 'set-comment', label: 'Set Comment', category: 'Active Tab' },
  { id: 'remove-comment', label: 'Remove Comment', category: 'Active Tab' },
  { id: 'move-tab', label: 'Move Tab...', category: 'Active Tab' },
  { id: 'add-to-new-group', label: 'Add to New Group...', category: 'Active Tab' },
  { id: 'ungroup-tab', label: 'Ungroup Tab', category: 'Active Tab' },
  { id: 'rename-tab-group', label: 'Rename Group…', category: 'Active Group' },
  { id: 'move-group', label: 'Move Group...', category: 'Active Group' },
  { id: 'duplicate-group', label: 'Duplicate Group', category: 'Active Group' },
  { id: 'ungroup-all-tabs', label: 'Ungroup All Tabs', category: 'Active Group' },
  { id: 'close-group', label: 'Close Group', category: 'Active Group', keywords: 'delete remove' },
  { id: 'new-tab', label: 'New Tab', category: 'Tabs' },
  { id: 'new-group', label: 'New Group…', category: 'Tabs', keywords: 'tab group create' },
  { id: 'reopen-closed-tab', label: 'Reopen Closed Tab', category: 'Tabs', keywords: 'undo restore' },
  { id: 'next-tab', label: 'Next Tab', category: 'Tabs' },
  { id: 'prev-tab', label: 'Previous Tab', category: 'Tabs' },
  { id: 'add-to-bookshelf', label: 'Add to Bookshelf', category: 'Bookshelf' },
  { id: 'toggle-bookshelf', label: 'Toggle Bookshelf', category: 'Bookshelf' },
  { id: 'new-workspace', label: 'New Workspace', category: 'Workspaces' },
  { id: 'close-workspace', label: 'Close Workspace', category: 'Workspaces' },
  { id: 'rename-workspace', label: 'Rename Workspace…', category: 'Workspaces' },
  { id: 'delete-workspace', label: 'Delete Workspace…', category: 'Workspaces' },
  { id: 'import-workspaces', label: 'Import Workspaces…', category: 'Workspaces' },
  { id: 'export-workspaces', label: 'Export Workspaces…', category: 'Workspaces' },
  { id: 'workspace-menu', label: 'Workspace Menu', category: 'Workspaces', keywords: 'switch list' },
  { id: 'new-profile', label: 'New Profile…', category: 'Profile', keywords: 'create' },
  { id: 'rename-profile', label: 'Rename Profile…', category: 'Profile' },
  { id: 'delete-profile', label: 'Delete Profile…', category: 'Profile' },
  { id: 'profile-menu', label: 'Profile Menu', category: 'Profile', keywords: 'switch list' },
  { id: 'expand-all-groups', label: 'Expand All Tab Groups', category: 'View' },
  { id: 'collapse-all-groups', label: 'Collapse All Tab Groups', category: 'View' },
  { id: 'chrome-hints', label: 'Hints on Browser Controls', category: 'View', keywords: 'labels buttons click keyboard vimium' },
  { id: 'zoom-in', label: 'Zoom In', category: 'View', keywords: 'bigger larger page' },
  { id: 'zoom-out', label: 'Zoom Out', category: 'View', keywords: 'smaller page' },
  { id: 'zoom-reset', label: 'Actual Size', category: 'View', keywords: 'zoom reset 100' },
  { id: 'focus-url', label: 'Focus Address Bar', category: 'Navigation' },
  { id: 'edit-url', label: 'Edit Address…', category: 'Navigation' },
  { id: 'back', label: 'Navigate Back', category: 'Navigation' },
  { id: 'forward', label: 'Navigate Forward', category: 'Navigation' },
  { id: 'reload', label: 'Reload Page', category: 'Navigation' },
  { id: 'page-devtools', label: 'Toggle Page Developer Tools', category: 'Navigation' },
  { id: 'ui-devtools', label: 'Toggle UI Developer Tools', category: 'View' },
  { id: 'find-in-page', label: 'Find in Page...', category: 'Navigation' },
  { id: 'save-page', label: 'Save Page As…', category: 'Navigation' },
  { id: 'copy-url', label: 'Copy Address', category: 'Navigation', keywords: 'url link clipboard' },
  { id: 'paste-url', label: 'Open Copied Address', category: 'Navigation', keywords: 'url link clipboard paste' },
  { id: 'paste-url-new-tab', label: 'Open Copied Address in New Tab', category: 'Navigation', keywords: 'url link clipboard paste' },
  { id: 'site-info', label: 'Site Info', category: 'Navigation', keywords: 'certificate padlock security connection' },
  { id: 'search', label: 'Search Everything', category: 'General' },
  { id: 'pick-tab', label: 'Search Tabs', category: 'General' },
  { id: 'pick-workspace', label: 'Search Workspaces', category: 'General' },
  { id: 'pick-group', label: 'Search Tab Groups', category: 'General' },
  { id: 'pick-profile', label: 'Search Profiles', category: 'General' },
  { id: 'app-menu', label: 'Open Menu', category: 'General' },
  { id: 'open-downloads', label: 'Open Downloads', category: 'General' },
  { id: 'open-bangs', label: 'Bangs & Search Engine', category: 'General' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', category: 'View' },
  { id: 'dark-pages', label: 'Turn Dark Pages On / Off', category: 'Dark Pages', keywords: 'dark mode night theme' },
  { id: 'dark-pages-site', label: 'Dark Pages on This Site', category: 'Dark Pages', keywords: 'dark mode site night theme' },
  { id: 'dark-pages-settings', label: 'Dark Pages Settings…', category: 'Dark Pages', keywords: 'dark mode night theme brightness contrast' },
  { id: 'dark-pages-menu', label: 'Dark Pages Menu', category: 'Dark Pages', keywords: 'dark mode night theme brightness contrast popover' },
  { id: 'extensions-menu', label: 'Extensions Menu', category: 'Extensions', keywords: 'add-ons plugins' },
  { id: 'manage-extensions', label: 'Manage Extensions', category: 'Extensions', keywords: 'add-ons plugins settings' },
  { id: 'split-right', label: 'Split Right', category: 'Split View' },
  { id: 'split-down', label: 'Split Down', category: 'Split View' },
  { id: 'split-focus', label: 'Switch Split Pane', category: 'Split View' },
  { id: 'split-close', label: 'Close Split', category: 'Split View' },
  { id: 'settings', label: 'Open Settings', category: 'General' },
  { id: 'help', label: 'Vim Mode Keys', category: 'General', keywords: 'help keymap shortcuts bindings' },
  { id: 'check-updates', label: 'Check for Updates', category: 'General', keywords: 'upgrade version' },
  { id: 'install-update', label: 'Restart to Install Update', category: 'General', keywords: 'upgrade version' },
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

export function CommandPalette({ open, onOpenChange, onAction, vimKeymap }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [hintSettings, setHintSettings] = useState<HintSettings | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const activeTab = useAppStore((s) => s.getActiveTab())
  // Group-scoped commands need a real group to operate on. The active tab
  // group can be null when the user is on an ungrouped (Root) tab.
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId)
  const splitShown = useSplitStore((s) => isSplitShown(s.split, activeTab?.id ?? null))

  // Fetch once — the version never changes for the life of the window.
  useEffect(() => {
    ;(window as any).electronAPI?.getAppVersion?.().then((v: string) => {
      if (v) setAppVersion(v)
    })
  }, [])

  const availableCommands = useMemo(() => {
    return COMMANDS.filter((cmd) => {
      if (cmd.id === 'remove-comment') return !!activeTab?.comment
      if (
        cmd.id === 'rename-tab-group' ||
        cmd.id === 'move-group' ||
        cmd.id === 'duplicate-group' ||
        cmd.id === 'ungroup-all-tabs' ||
        cmd.id === 'close-group'
      ) {
        return !!activeTabGroupId
      }
      // Vim mode's own: the labels are typed with COMMAND's keys.
      if (cmd.id === 'chrome-hints' || cmd.id === 'help') return !!vimKeymap
      // A tab in a group (not the group header parked with no active tab).
      if (cmd.id === 'ungroup-tab') return !!activeTab && !!activeTabGroupId
      if (cmd.id === 'split-focus' || cmd.id === 'split-close') return splitShown
      // An address to edit: not parked on a group, nor on a page of the
      // browser's own (openUrlEditor refuses those).
      if (cmd.id === 'edit-url') return !!activeTab && !isInternalUrl(activeTab.url)
      return true
    })
  }, [activeTab, activeTabGroupId, splitShown, vimKeymap])

  useEffect(() => {
    if (open) {
      setSelectedIndex(0)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
      ;(window as any).electronAPI.loadSettings().then((s: HintSettings | null) => {
        if (s) setHintSettings(s)
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
          cmd.keywords ? fuzzyScore(query, cmd.keywords) : 0,
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
  // The commands in the order they're shown — grouping pulls a category's
  // later commands up to its first, so this isn't `filtered`'s order. The
  // selection and the row numbers count in it.
  const rows = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

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

  // Vim mode: the palette opens in INSERT — typing filters, like vim's `:`
  // command line. Ctrl+C goes to COMMAND, where j/k walk the list and a
  // row's label runs it; i types again. Esc closes from either.
  // COMMAND mode's row labels (lib/hint-labels.ts).
  const hints = usePopupHints(vimKeymap, rows.length)
  const vim = usePopupVimMode({
    keymap: hints.keymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'insert',
    open,
    onCommand: (command) => {
      const hinted = hintIndex(command)
      if (hinted !== null) {
        const cmd = rows[hinted]
        if (cmd) handleSelect(cmd)
        return
      }
      const row = /^search-row-(\d)$/.exec(command)
      if (row) {
        const cmd = rows[Number(row[1]) - 1]
        if (cmd) handleSelect(cmd)
        return
      }
      switch (command) {
        case 'insert-mode': inputRef.current?.focus(); break
        case 'cursor-down': setSelectedIndex((i) => Math.min(i + 1, rows.length - 1)); break
        case 'cursor-up': setSelectedIndex((i) => Math.max(i - 1, 0)); break
        case 'cursor-first': setSelectedIndex(0); break
        case 'cursor-last': setSelectedIndex(Math.max(rows.length - 1, 0)); break
        case 'row-open': if (rows[selectedIndex]) handleSelect(rows[selectedIndex]); break
      }
    },
    onEscape: () => onOpenChange(false),
  })

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[selectedIndex]) handleSelect(rows[selectedIndex])
    } else if (e.key === 'Escape') {
      // In Vim mode Esc never gets here: the palette's Vim keys close it.
      onOpenChange(false)
    }
  }, [rows, selectedIndex, handleSelect, onOpenChange])

  if (!open) return null

  let flatIdx = 0

  return (
    <DetachedWindow
      open={open}
      title="Command Palette - Vimperium"
      width={760}
      height={640}
      closeOnBlur
      matchRunwaPalette
      // In Vim mode Esc is the palette's Vim keys' (usePopupVimMode), which close it.
      closeOnEscape={!vimKeymap}
      onClose={() => onOpenChange(false)}
      onWindowChange={setPopupWindow}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="px-4 py-2.5 border-b border-border shrink-0"
        >
          <InputField inputRef={inputRef} mode={vim.mode} pending={vim.pending} className="h-10">
            <Command size={16} className="text-muted-foreground shrink-0" />
            <input
              data-detached-drag-handle
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={vim.onBoxFocus}
              onBlur={vim.onBoxBlur}
              placeholder={vim.mode === 'command' && vimKeyCaps(vimKeymap, 'insert-mode')[0]
                ? `Type a command... (${vimKeyCaps(vimKeymap, 'insert-mode')[0]} to type)`
                : 'Type a command...'}
              className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
            />
          </InputField>
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
                // hint so we don't lie about a shortcut that won't fire. In
                // Vim mode the hint is the command's COMMAND-mode key.
                const hint = actionHint(hintSettings, cmd.id, getDefaultBinding(cmd.id))
                return (
                  <div
                    key={cmd.id}
                    data-selected={isSelected}
                    className={`relative flex items-center justify-between px-4 py-1.5 cursor-pointer text-sm ${
                      isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                    }`}
                    onClick={() => handleSelect(cmd)}
                  >
                    <RowHint mode={vim.mode} label={hints.labels[idx]} number={idx + 1} pending={vim.pending} className="absolute left-0 top-1/2 -translate-y-1/2" />
                    <span>{cmd.label}</span>
                    {hint && (
                      <span className="text-xs text-muted-foreground ml-4 shrink-0 flex items-center">
                        {hint.kind === 'vim' ? <kbd className="font-mono">{hint.keys}</kbd> : formatKeybinding(hint.accelerator)}
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

        {/* The keys, along the bottom as everywhere. */}
        <div data-detached-drag-handle>
          <HintBar>
            {vim.mode === 'command' ? (
              <>
                <Hint label="Navigate" keys={vimKeyCaps(vimKeymap, 'cursor-down', 'cursor-up')} />
                <Hint label="Run" keys={vimKeyCaps(vimKeymap, 'row-open')} />
                {hints.labels[0] && <Hint label="Run row" keys={[`${hints.labels[0]}…`]} />}
                <Hint label="Type" keys={vimKeyCaps(vimKeymap, 'insert-mode')} />
                <Hint label="Close" keys={['Esc']} />
              </>
            ) : (
              <>
                <Hint label="Navigate" keys={['↓', '↑']} />
                <Hint label="Run" keys={['Enter']} />
                {vim.mode && <Hint label="Command mode" keys={[LEAVE_INSERT_CAP]} />}
                <Hint label="Close" keys={['Esc']} />
              </>
            )}
            {appVersion && <span className="text-muted-foreground/60 tabular-nums">v{appVersion}</span>}
          </HintBar>
        </div>
      </div>
    </DetachedWindow>
  )
}

const DEFAULT_BINDINGS: Record<string, string> = {
  'new-tab': 'CmdOrCtrl+T',
  'close-tab': 'CmdOrCtrl+W',
  'reopen-closed-tab': 'CmdOrCtrl+Shift+T',
  'close-window': 'CmdOrCtrl+Shift+W',
  'new-workspace': 'CmdOrCtrl+Shift+N',
  'next-tab': 'CmdOrCtrl+Tab',
  'prev-tab': 'CmdOrCtrl+Shift+Tab',
  'toggle-sidebar': 'CmdOrCtrl+\\',
  'focus-url': 'CmdOrCtrl+L',
  'search': 'CmdOrCtrl+P',
  'command-palette': 'CmdOrCtrl+Shift+P',
  'back': 'CmdOrCtrl+[',
  'forward': 'CmdOrCtrl+]',
  'reload': 'CmdOrCtrl+R',
  'settings': 'CmdOrCtrl+,',
  'page-devtools': 'CmdOrCtrl+Shift+I',
  'save-page': 'CmdOrCtrl+S',
  'toggle-bookshelf': 'CmdOrCtrl+Shift+B',
  'open-downloads': 'CmdOrCtrl+J',
  'dark-pages': 'Alt+Shift+D',
  'dark-pages-site': 'Alt+Shift+A',
}

function getDefaultBinding(id: string): string | undefined {
  return DEFAULT_BINDINGS[id]
}
