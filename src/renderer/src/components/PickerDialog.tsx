import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, ArrowUpDown, CornerDownLeft } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { fuzzyFilter } from '../lib/fuzzy'

const isMac = navigator.platform.includes('Mac')
const META = isMac ? '⌘' : 'Ctrl'

export interface PickerItem {
  id: string
  /** Primary label shown in bold/foreground. */
  label: string
  /** Optional secondary text shown below in muted-foreground. */
  subLabel?: string
  /** When set, renders a colored dot at the row's leading edge. */
  color?: string
  /** Items sharing the same `section` value are rendered under one header. */
  section?: string
  /** Optional verb-style hint shown right of the row, e.g. "Root". */
  trailingNote?: string
}

interface ScopeChoice {
  /** 'current' = first tab — restricted scope; 'all' = second tab — full corpus. */
  value: 'current' | 'all'
  label: string
}

interface Props {
  open: boolean
  title: string
  /** Window title displayed by the OS in the popup's chrome — defaults to title. */
  windowTitle?: string
  /** Optional "what's being acted on" subline under the search field. */
  subtitle?: React.ReactNode
  placeholder?: string
  width?: number
  height?: number
  /** Items the picker should display. The CALLER is responsible for filtering
   *  by scope / removing self-references — the dialog just lays them out. */
  items: PickerItem[]
  /** Empty-state message shown when there are no items to pick from at all
   *  (i.e. items list is empty for the current scope). */
  emptyMessage?: string
  /** Verb to put on the confirm action in the footer (e.g. "Move", "Copy"). */
  confirmVerb?: string
  /** When set, holding Shift while confirming (Enter or click) is surfaced to
   *  `onConfirm` via `opts.background`, and this label is shown next to a
   *  ⇧↵ hint in the footer (e.g. "Stay here"). Omit for dialogs with no
   *  background variant. */
  backgroundHint?: string
  /** Item id to pre-select when the dialog opens. Falls back to the first
   *  row if the id isn't present in the (filtered) list. */
  initialItemId?: string
  scope: 'current' | 'all'
  onScopeChange: (scope: 'current' | 'all') => void
  scopeChoices: [ScopeChoice, ScopeChoice]
  /** `opts.background` is true when the user held Shift while confirming. */
  onConfirm: (itemId: string, opts: { background: boolean }) => void
  onCancel: () => void
}

export function PickerDialog({
  open,
  title,
  windowTitle,
  subtitle,
  placeholder = 'Search…',
  width = 520,
  height = 480,
  items,
  emptyMessage = 'Nothing to show.',
  confirmVerb = 'Select',
  backgroundHint,
  initialItemId,
  scope,
  onScopeChange,
  scopeChoices,
  onConfirm,
  onCancel,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state every time the dialog re-opens. Without this,
  // closing and re-opening the picker would carry stale search text and
  // selection across actions.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    return fuzzyFilter(query, items, (item) => [
      { value: item.label, weight: 1 },
      { value: item.subLabel, weight: 0.6 },
      { value: item.section, weight: 0.4 },
      { value: item.trailingNote, weight: 0.3 },
    ])
  }, [query, items])

  // Keep selection within bounds and reset whenever the result set changes
  // (search, scope toggle). If the caller supplied an `initialItemId` that's
  // present in the filtered list, anchor to it; otherwise fall back to the
  // top row.
  useEffect(() => {
    if (initialItemId) {
      const idx = filtered.findIndex((i) => i.id === initialItemId)
      if (idx !== -1) {
        setSelectedIndex(idx)
        return
      }
    }
    setSelectedIndex(0)
  }, [query, scope, items, filtered, initialItemId])

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Group items by section while preserving the input order. Groups appear
  // in the order their first member appears in the filtered list.
  const sections = useMemo(() => {
    const out: { name: string | null; items: PickerItem[] }[] = []
    const byName = new Map<string | null, PickerItem[]>()
    for (const item of filtered) {
      const key = item.section ?? null
      let bucket = byName.get(key)
      if (!bucket) {
        bucket = []
        byName.set(key, bucket)
        out.push({ name: key, items: bucket })
      }
      bucket.push(item)
    }
    return out
  }, [filtered])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Cmd+1 / Cmd+2 (Ctrl+1 / Ctrl+2 on non-mac) flip the scope. We use
    // metaKey on macOS and ctrlKey elsewhere to match the platform's
    // accelerator convention.
    const isMetaPressed = isMac ? e.metaKey : e.ctrlKey
    if (isMetaPressed && !e.shiftKey && !e.altKey) {
      if (e.code === 'Digit1') {
        e.preventDefault()
        onScopeChange(scopeChoices[0].value)
        return
      }
      if (e.code === 'Digit2') {
        e.preventDefault()
        onScopeChange(scopeChoices[1].value)
        return
      }
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = filtered[selectedIndex]
      if (picked) onConfirm(picked.id, { background: e.shiftKey })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  if (!open) return null

  // Pre-compute a flat-index → item-id map so we can highlight the right row
  // as the user arrows through grouped output.
  let flatIdx = 0

  return (
    <DetachedWindow
      open={open}
      title={windowTitle ?? title}
      width={width}
      height={height}
      resizable={false}
      closeOnBlur
      onClose={onCancel}
    >
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
            placeholder={placeholder}
            className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {subtitle && (
          <div className="px-4 py-1.5 border-b border-border text-[11px] text-muted-foreground truncate shrink-0">
            {subtitle}
          </div>
        )}

        {/* Scope tabs. The dialog is fully controlled — scope state lives in
            the caller so the items list and the highlighted button stay in
            sync without an extra round-trip. */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
          {scopeChoices.map((choice, i) => {
            const active = scope === choice.value
            return (
              <button
                key={choice.value}
                type="button"
                onClick={() => onScopeChange(choice.value)}
                className={`flex items-center gap-1 h-6 px-2 rounded-full text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-secondary text-muted-foreground border border-transparent hover:bg-accent'
                }`}
              >
                {choice.label}
                <span className="opacity-50 ml-0.5">{META}{i + 1}</span>
              </button>
            )
          })}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {items.length === 0 ? emptyMessage : 'No matches'}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.name ?? '__default__'}>
                {section.name && (
                  <div className="px-4 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {section.name}
                  </div>
                )}
                {section.items.map((item) => {
                  const idx = flatIdx++
                  const isSelected = idx === selectedIndex
                  return (
                    <div
                      key={item.id}
                      data-selected={isSelected}
                      className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm ${
                        isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                      }`}
                      onClick={(e) => onConfirm(item.id, { background: e.shiftKey })}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      {item.color !== undefined && (
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{item.label}</div>
                        {item.subLabel && (
                          <div className="text-[10px] text-muted-foreground truncate">
                            {item.subLabel}
                          </div>
                        )}
                      </div>
                      {item.trailingNote && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {item.trailingNote}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div
          data-detached-drag-handle
          className="h-10 px-3 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0"
        >
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">Navigate <kbd><ArrowUpDown size={11} strokeWidth={2.5} /></kbd></span>
            <span className="flex items-center gap-1">{confirmVerb} <kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd></span>
            {backgroundHint && (
              <span className="flex items-center gap-1">{backgroundHint} <kbd>⇧</kbd><kbd><CornerDownLeft size={11} strokeWidth={2.5} /></kbd></span>
            )}
            <span className="flex items-center gap-1">Scope <kbd>{META}</kbd><kbd>1/2</kbd></span>
          </div>
          <span className="flex items-center gap-1">Close <kbd>Esc</kbd></span>
        </div>
      </div>
    </DetachedWindow>
  )
}
