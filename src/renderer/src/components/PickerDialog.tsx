import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, ArrowUpDown, CornerDownLeft } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { GroupPill } from './GroupPill'
import { ScopeSwitch } from './ScopeSwitch'
import { fuzzyFilter } from '../lib/fuzzy'

/** One crumb of a row's location path. `pill` marks the segment that names a
 *  tab group, which is rendered as a colored pill like the sidebar's group
 *  header — except on that group's own row, whose label already carries the
 *  color, so the crumb stays plain there. */
export interface PickerPathSegment {
  label: string
  pill?: boolean
}

export interface PickerItem {
  id: string
  /** Primary label shown in bold/foreground. */
  label: string
  /** Full location path shown as a breadcrumb beneath the label
   *  ("Profile / Workspace / Group"), matching the search window. */
  path?: PickerPathSegment[]
  /** Tab-group color. Its presence marks the row as a tab group: the label
   *  is drawn as the group's pill and the path's `pill` segment stays plain,
   *  so the group is colored once per row. */
  color?: string
  /** Items sharing the same `section` value are rendered under one header. */
  section?: string
  /** Optional verb-style hint shown right of the row, e.g. "Root". */
  trailingNote?: string
}

function pathText(segments: PickerPathSegment[]): string {
  return segments.map((s) => s.label).join(' / ')
}

function PickerPath({ segments, pills }: { segments: PickerPathSegment[]; pills: boolean }) {
  return (
    <div className="text-[10px] text-muted-foreground truncate" title={pathText(segments)}>
      {segments.map((segment, index) => (
        <span key={`${index}-${segment.label}`}>
          {index > 0 && <span aria-hidden="true"> / </span>}
          {segment.pill && pills ? <GroupPill name={segment.label} /> : segment.label}
        </span>
      ))}
    </div>
  )
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
  /** Verb to put on the confirm action in the footer (e.g. "Move", "Open"). */
  confirmVerb?: string
  /** When set, holding Shift while confirming (Enter or click) is surfaced to
   *  `onConfirm` via `opts.background`, and this label is shown next to a
   *  ⇧↵ hint in the footer (e.g. "Stay here"). Omit for dialogs with no
   *  background variant. */
  backgroundHint?: string
  /** Item id to pre-select when the dialog opens. Falls back to the first
   *  row if the id isn't present in the (filtered) list. */
  initialItemId?: string
  /** 'current' narrows the list to where the user is; 'all' spans everything.
   *  Leave the scope props out for a picker with nothing to narrow — the
   *  switch, its Tab key and its footer hint are left out with them. */
  scope?: 'current' | 'all'
  onScopeChange?: (scope: 'current' | 'all') => void
  /** What the scope switch reads in each position, e.g. "This workspace" /
   *  "All workspaces". */
  scopeLabels?: Record<'current' | 'all', string>
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
  scopeLabels,
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
      // The path carries the profile / workspace / group context, so typing a
      // workspace name narrows to its destinations even though no section
      // header spells it out any more.
      { value: item.path && pathText(item.path), weight: 0.6 },
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

  const scopeSwitch = scope && onScopeChange && scopeLabels
    ? { scope, onScopeChange, scopeLabels }
    : null

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Tab flips the scope switch (and Shift+Tab does the same — there are
    // only two positions). We trap it so focus stays in the search input
    // rather than tabbing out to the switch.
    if (scopeSwitch && e.key === 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      scopeSwitch.onScopeChange(scopeSwitch.scope === 'current' ? 'all' : 'current')
      return
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

        {/* What's being acted on, with the scope switch at the row's end —
            the same switch, in the same spot, as the search window's. The
            dialog is fully controlled: scope state lives in the caller so
            the items list and the switch stay in sync without an extra
            round-trip. */}
        {(subtitle || scopeSwitch) && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border shrink-0">
            {subtitle && (
              <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {subtitle}
              </div>
            )}
            {scopeSwitch && (
              <ScopeSwitch
                on={scopeSwitch.scope === 'current'}
                label={scopeSwitch.scopeLabels[scopeSwitch.scope]}
                onToggle={() => {
                  scopeSwitch.onScopeChange(scopeSwitch.scope === 'current' ? 'all' : 'current')
                  // A click moves focus to the switch; hand it back so typing and
                  // the arrow keys keep driving the list.
                  inputRef.current?.focus()
                }}
                title="Toggle scope (Tab)"
                className="ml-auto shrink-0"
              />
            )}
          </div>
        )}

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
                      // Carrying the group color as `--gc` lets the theme
                      // resolve it once for the whole row, so the label's pill
                      // and the path's pill are always the same shade.
                      data-group-container={item.color ? '' : undefined}
                      style={item.color ? { ['--gc' as string]: item.color } : undefined}
                      className={`flex items-center gap-2 px-4 py-1.5 cursor-pointer text-sm ${
                        isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/50'
                      }`}
                      onClick={(e) => onConfirm(item.id, { background: e.shiftKey })}
                      onMouseEnter={() => setSelectedIndex(idx)}
                    >
                      <div className="flex-1 min-w-0">
                        {item.color ? (
                          <GroupPill name={item.label} className="block w-fit max-w-full truncate" />
                        ) : (
                          <div className="truncate">{item.label}</div>
                        )}
                        {item.path && <PickerPath segments={item.path} pills={!item.color} />}
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
            {scopeSwitch && <span className="flex items-center gap-1">Scope <kbd>⇥</kbd></span>}
          </div>
          <span className="flex items-center gap-1">Close <kbd>Esc</kbd></span>
        </div>
      </div>
    </DetachedWindow>
  )
}
