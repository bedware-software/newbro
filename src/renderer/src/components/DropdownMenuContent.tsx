import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  User, Layout, Search, Settings, Download, Info, LogOut, Plus, Pencil, Trash2, Menu, Globe, Import,
  Upload, X, FolderPlus, FolderMinus, FolderInput, Folder, CopyPlus, MessageSquare,
  MessageSquareOff, FilePlus, Pin, PinOff, EyeOff, Puzzle, PanelLeft, PanelLeftClose, Check,
  FolderOpen, Link, Pause, Play, RotateCw, ListX, Zap,
} from 'lucide-react'
import type {
  DropdownAction,
  DropdownColor,
  DropdownEventBody,
  DropdownItem,
  DropdownSpec,
  IconName,
} from './dropdown-protocol'

// String-keyed icon registry. Spec sends icon NAMES (strings) over IPC; the
// popup resolves them here. Keep in sync with IconName in dropdown-protocol.ts.
const ICONS: Record<IconName, typeof User> = {
  User, Layout, Search, Settings, Download, Info, LogOut, Plus, Pencil, Trash2, Menu, Globe, Import,
  Upload, X, FolderPlus, FolderMinus, FolderInput, Folder, CopyPlus, MessageSquare,
  MessageSquareOff, FilePlus, Pin, PinOff, EyeOff, Puzzle, PanelLeft, PanelLeftClose,
  FolderOpen, Link, Pause, Play, RotateCw, ListX, Zap,
}

function resolveIcon(name: IconName | undefined, fallback: typeof User = User): typeof User {
  if (!name) return fallback
  return ICONS[name] ?? fallback
}

function SortableRow({
  item,
  selected,
  Icon,
  sortable,
  editable,
  deletable,
  focused = false,
  keyboard = false,
  digit,
  onEmit,
}: {
  item: DropdownItem
  selected: boolean
  Icon: typeof User
  sortable: boolean
  editable: boolean
  deletable: boolean
  /** Highlighted by keyboard navigation: its rename and delete show, with
   *  their keys. */
  focused?: boolean
  /** The list was opened from the keyboard: rows show their keys. */
  keyboard?: boolean
  /** The digit that picks it at once (the first nine rows). */
  digit?: string
  onEmit: (evt: DropdownEventBody) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !sortable,
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
      {...(focused ? { 'data-key-focus': '' } : {})}
      className={`flex items-center gap-2 px-3 py-1.5 group/row transition-colors ${
        selected
          ? 'bg-accent text-accent-foreground'
          : focused ? 'bg-accent/50 text-foreground' : 'text-foreground hover:bg-accent/50'
      } ${focused ? 'ring-1 ring-inset ring-primary/60' : ''} ${isDragging ? 'opacity-60' : ''} ${sortable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <button
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        onClick={() => onEmit({ type: 'select', id: item.id })}
      >
        <Icon size={12} className="text-muted-foreground shrink-0" />
        <span className="truncate">{item.name}</span>
      </button>
      {/* Shown on hover, on a Tab-focused button, and on the row the keys
          are on — with their keys then. */}
      <div className={`flex items-center gap-0.5 shrink-0 transition-all ${
        focused ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100'
      }`}>
        {editable && (
          <button
            data-row-action
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onEmit({ type: 'edit', id: item.id, name: item.name })
            }}
            title={`Rename ${item.name}`}
          >
            <Pencil size={11} />
          </button>
        )}
        {focused && editable && <kbd className="font-mono mr-1">{ROW_KEYS.rename}</kbd>}
        {deletable && (
          <button
            data-row-action
            onPointerDown={(e) => e.stopPropagation()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onEmit({ type: 'delete', id: item.id, name: item.name })
            }}
            title={`Delete ${item.name}`}
          >
            <Trash2 size={11} />
          </button>
        )}
        {focused && deletable && <kbd className="font-mono">{ROW_KEYS.delete}</kbd>}
      </div>
      {keyboard && digit && <kbd className="font-mono text-muted-foreground shrink-0">{digit}</kbd>}
    </div>
  )
}

// Edge-style swatch strip. Sized so the full 12-colour palette lands on one
// line *within the popup window's initial width* (12x18px + 11x4px gaps +
// 24px padding = 260px, comfortably under the 288px content box you get
// before the measure/resize round-trip) — otherwise the strip would paint
// wrapped for a frame and then snap. `flex-wrap` is the safety net if a
// caller ever passes a longer palette.
//
// Each circle carries `data-group-container` + `--gc` so the stored hex runs
// through the same per-theme resolution the sidebar pill uses — see the
// [data-group-swatch] rules in globals.css. Painting the raw hex here made
// the swatches read darker than the group they produced under the light
// theme. Rings live in that CSS too (inset, so selection never grows the
// swatch's layout box and pushes the strip wider).
function ColorStrip({
  colors,
  selected,
  focusedIndex,
  onEmit,
}: {
  colors: DropdownColor[]
  selected?: string | null
  /** Swatch highlighted by keyboard navigation, if any. */
  focusedIndex: number | null
  onEmit: (evt: DropdownEventBody) => void
}) {
  const norm = (c: string): string => c.trim().toLowerCase()
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
      {colors.map((c, index) => {
        const isSelected = !!selected && norm(selected) === norm(c.value)
        return (
          <button
            key={c.value}
            data-group-container=""
            data-group-swatch=""
            {...(isSelected ? { 'data-selected': '' } : {})}
            {...(focusedIndex === index ? { 'data-focused': '' } : {})}
            title={c.label}
            aria-label={c.label}
            aria-pressed={isSelected}
            onClick={() => onEmit({ type: 'color', color: c.value })}
            className="h-[18px] w-[18px] shrink-0 rounded-full flex items-center justify-center transition-transform hover:scale-110"
            style={{ ['--gc' as string]: c.value }}
          >
            {isSelected && <Check size={11} strokeWidth={3} />}
          </button>
        )
      })}
    </div>
  )
}

// The menu's own moves (j/k through the rows and actions, h/l across the
// swatches), which no action's key may take.
const MOVE_KEYS = new Set(['j', 'k', 'h', 'l'])

// A list's keys for the row the keys are on (the toolbar's profiles and
// workspaces): rename it, delete it (d, as dd deletes), make a new one.
// Shift+J/K move it down and up; a digit picks one of the first nine.
const ROW_KEYS = { rename: 'r', delete: 'd', new: 'n' } as const
const ROW_MOVE_KEYS = ['J', 'K']
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/** Each enabled action's one key, by index: its own `key`, else its
 *  shortcut when that's one plain key (the Downloads page's f, c, x…), else
 *  the first letter of a word of its label no other action has, else of
 *  anywhere in it, else a digit. None of `reserved` (a list's row keys). */
export function menuKeys(actions: DropdownAction[], reserved: Iterable<string> = []): Map<number, string> {
  const keys = new Map<number, string>()
  const taken = new Set([...MOVE_KEYS, ...reserved])
  actions.forEach((a, i) => {
    const own = a.key ?? (a.shortcut?.length === 1 && /^[a-zA-Z0-9]$/.test(a.shortcut[0]) ? a.shortcut[0] : undefined)
    if (a.disabled || !own || taken.has(own)) return
    keys.set(i, own)
    taken.add(own)
  })
  const free = (ch: string | undefined): string | null => {
    const key = ch?.toLowerCase()
    return key && /^[a-z]$/.test(key) && !taken.has(key) ? key : null
  }
  actions.forEach((a, i) => {
    if (a.disabled || keys.has(i)) return
    const words = a.label.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    const key = words.map((w) => free(w[0])).find(Boolean) ??
      [...a.label].map((ch) => free(ch)).find(Boolean) ??
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find((d) => !taken.has(d)) ?? null
    if (!key) return
    keys.set(i, key)
    taken.add(key)
  })
  return keys
}

/** The key an event stands for, by position on the keyboard (any input
 *  language): a letter, capital with Shift, or a digit. */
function positionalKey(e: KeyboardEvent): string | null {
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return e.shiftKey ? letter[1] : letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(e.code)
  return digit && !e.shiftKey ? digit[1] : null
}

function ActionRow({
  action,
  focused,
  menuKey,
  onEmit,
}: {
  action: DropdownAction
  /** Highlighted by keyboard navigation. */
  focused: boolean
  /** Its one key, in a menu opened from the keyboard. */
  menuKey?: string
  onEmit: (evt: DropdownEventBody) => void
}) {
  const Icon = resolveIcon(action.iconName)
  const disabled = !!action.disabled
  return (
    <button
      {...(focused ? { 'data-key-focus': '' } : {})}
      onClick={() => { if (!disabled) onEmit({ type: 'action', actionId: action.id }) }}
      disabled={disabled}
      title={disabled ? action.disabledTitle : undefined}
      className={`w-full flex items-center justify-between px-3 py-1.5 text-left ${
        disabled
          ? 'opacity-60 cursor-not-allowed text-muted-foreground'
          : `hover:bg-accent ${focused ? 'bg-accent' : ''} ${action.destructive ? 'text-destructive' : ''}`
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon size={14} className={action.destructive && !disabled ? '' : 'text-muted-foreground'} />
        <span>{action.label}</span>
      </span>
      {menuKey ? (
        // From the keyboard its one key is what matters (the regular
        // shortcuts are off in Vim mode anyway).
        <span className="ml-4 inline-flex items-center text-muted-foreground">
          <kbd className="font-mono">{menuKey}</kbd>
        </span>
      ) : action.shortcut && action.shortcut.length > 0 && (
        <span className="inline-flex items-center gap-0.5 text-muted-foreground">
          {action.shortcut.map((seg, i) => <kbd key={i}>{seg}</kbd>)}
        </span>
      )}
    </button>
  )
}

export function DropdownMenuContent({
  spec,
  onEmit,
  onMeasured,
}: {
  spec: DropdownSpec
  onEmit: (evt: DropdownEventBody) => void
  // Called when the menu's natural size is known so the host window can resize.
  onMeasured?: (size: { width: number; height: number }) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Report the menu's natural rendered size to the host (the popup window
  // uses this to resize itself snugly around the content). offsetWidth /
  // scrollHeight give the layout box's full dimensions even when an ancestor
  // is overflow-hidden — getBoundingClientRect alone proved unreliable on
  // first paint when the window starts smaller than the menu and the body's
  // overflow:hidden was clipping the rect to the visible area on some
  // layouts. Re-measure on rAF so we catch any post-mount layout settling
  // (font load, image decode), and on every ResizeObserver tick after that.
  useEffect(() => {
    const el = ref.current
    if (!el || !onMeasured) return
    let lastW = 0
    let lastH = 0
    const measure = (): void => {
      const w = Math.max(el.offsetWidth, el.scrollWidth)
      const h = Math.max(el.offsetHeight, el.scrollHeight)
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
      onMeasured({ width: w, height: h })
    }
    measure()
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [onMeasured, spec])

  // Esc closes — the host window may also handle blur, but Esc inside the
  // popup is the most common close path.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onEmit({ type: 'cancel' })
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onEmit])

  // The rows in the order shown: moved with the keys or a drag, they move
  // here at once (the opener reorders its own list as the events come, and
  // the next spec brings its order).
  const [moved, setMoved] = useState<{ spec: DropdownSpec; items: DropdownItem[] } | null>(null)
  const items = moved && moved.spec === spec ? moved.items : spec.items ?? []
  const setItems = (next: DropdownItem[]): void => setMoved({ spec, items: next })
  const Icon = resolveIcon(spec.iconName)
  const actions = spec.actions ?? []
  const colors = spec.colors ?? []
  const canEdit = !!spec.editable
  const canDelete = !!spec.deletable && !!spec.canDelete

  // Keyboard navigation for menus and lists opened from the keyboard: j/k
  // (or ↓/↑) step through the rows, the New… row and the enabled actions,
  // h/l across the colour swatches, and Enter picks whichever was moved to
  // last; an action's own key picks it. On a list's row, r renames it, d
  // deletes it, Shift+J/K move it; n is New…, a digit picks a row.
  const rowKeys = items.length > 0
  const reserved = useMemo(
    () => (rowKeys ? [...Object.values(ROW_KEYS), ...ROW_MOVE_KEYS, ...DIGITS.slice(0, items.length)] : []),
    [rowKeys, items.length],
  )
  const keys = useMemo(() => (spec.keyboard ? menuKeys(actions, reserved) : new Map<number, string>()), [spec, actions, reserved])
  type KeyFocus = { zone: 'items' | 'new' | 'actions' | 'colors'; index: number }
  const [keyFocus, setKeyFocus] = useState<KeyFocus | null>(null)
  useEffect(() => {
    if (!spec.keyboard) {
      setKeyFocus(null)
      return
    }
    const list = spec.items ?? []
    // A list starts on the current row; a menu on its first action.
    const current = list.findIndex((it) => it.id === spec.selectedId)
    const first = (spec.actions ?? []).findIndex((a) => !a.disabled)
    setKeyFocus(
      list.length > 0 ? { zone: 'items', index: Math.max(0, current) }
        : spec.newAction ? { zone: 'new', index: 0 }
          : first !== -1 ? { zone: 'actions', index: first } : null,
    )
  }, [spec])

  // The focused row stays in sight in a long list.
  useEffect(() => {
    ref.current?.querySelector('[data-key-focus]')?.scrollIntoView({ block: 'nearest' })
  }, [keyFocus])

  useEffect(() => {
    if (!spec.keyboard) return
    // j/k's stops, top to bottom.
    const stops: KeyFocus[] = [
      ...items.map((_, index) => ({ zone: 'items' as const, index })),
      ...(spec.newAction ? [{ zone: 'new' as const, index: 0 }] : []),
      ...actions.flatMap((a, index) => (a.disabled ? [] : [{ zone: 'actions' as const, index }])),
    ]
    const focusedItem = keyFocus?.zone === 'items' ? items[keyFocus.index] : undefined
    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const pressed = positionalKey(e)
      if (pressed && !MOVE_KEYS.has(pressed)) {
        // A list's own keys first.
        if (rowKeys) {
          if (pressed === ROW_KEYS.new && spec.newAction) {
            e.preventDefault()
            onEmit({ type: 'new' })
            return
          }
          if (pressed === ROW_KEYS.rename && focusedItem && canEdit) {
            e.preventDefault()
            onEmit({ type: 'edit', id: focusedItem.id, name: focusedItem.name })
            return
          }
          if (pressed === ROW_KEYS.delete && focusedItem && canDelete) {
            e.preventDefault()
            onEmit({ type: 'delete', id: focusedItem.id, name: focusedItem.name })
            return
          }
          if (ROW_MOVE_KEYS.includes(pressed) && focusedItem && spec.reorder && keyFocus) {
            e.preventDefault()
            const from = keyFocus.index
            const to = from + (pressed === 'J' ? 1 : -1)
            if (to < 0 || to >= items.length) return
            const next = [...items]
            next.splice(to, 0, ...next.splice(from, 1))
            setItems(next)
            setKeyFocus({ zone: 'items', index: to })
            onEmit({ type: 'reorder', sourceId: focusedItem.id, sourceIndex: from, targetIndex: to })
            return
          }
          const digit = DIGITS.indexOf(pressed)
          if (digit !== -1 && items[digit]) {
            e.preventDefault()
            onEmit({ type: 'select', id: items[digit].id })
            return
          }
        }
        for (const [index, key] of keys) {
          if (key !== pressed) continue
          e.preventDefault()
          onEmit({ type: 'action', actionId: actions[index].id })
          return
        }
      }
      // The moves go by position too.
      const move = pressed && MOVE_KEYS.has(pressed) ? pressed : e.key
      const step = move === 'j' || move === 'ArrowDown' ? 1 : move === 'k' || move === 'ArrowUp' ? -1 : 0
      if (step !== 0) {
        if (stops.length === 0) return
        e.preventDefault()
        setKeyFocus((prev) => {
          // Back from the swatches: resume on the stop last highlighted.
          const at = prev ? stops.findIndex((st) => st.zone === prev.zone && st.index === prev.index) : -1
          if (at === -1) return stops[0]
          return stops[Math.max(0, Math.min(stops.length - 1, at + step))]
        })
      } else if (move === 'h' || move === 'l') {
        if (colors.length === 0) return
        e.preventDefault()
        setKeyFocus((prev) => {
          // Entering the strip starts from the group's current colour.
          const from = prev?.zone === 'colors'
            ? prev.index
            : colors.findIndex((c) => c.value.trim().toLowerCase() === spec.selectedColor?.trim().toLowerCase())
          const at = from === -1 ? 0 : from + (move === 'l' ? 1 : -1)
          return { zone: 'colors', index: Math.max(0, Math.min(colors.length - 1, at)) }
        })
      } else if (e.key === 'Enter' && keyFocus) {
        e.preventDefault()
        if (keyFocus.zone === 'colors') {
          const color = colors[keyFocus.index]
          if (color) onEmit({ type: 'color', color: color.value })
        } else if (keyFocus.zone === 'items') {
          if (focusedItem) onEmit({ type: 'select', id: focusedItem.id })
        } else if (keyFocus.zone === 'new') {
          onEmit({ type: 'new' })
        } else {
          const action = actions[keyFocus.index]
          if (action && !action.disabled) onEmit({ type: 'action', actionId: action.id })
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [spec, items, actions, colors, keyFocus, keys, rowKeys, canEdit, canDelete, onEmit])

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over) return
    const sourceId = String(active.id)
    const targetId = String(over.id)
    if (sourceId === targetId) return
    const sourceIndex = items.findIndex((it) => it.id === sourceId)
    const targetIndex = items.findIndex((it) => it.id === targetId)
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return
    const next = [...items]
    next.splice(targetIndex, 0, ...next.splice(sourceIndex, 1))
    setItems(next)
    if (keyFocus?.zone === 'items' && keyFocus.index === sourceIndex) setKeyFocus({ zone: 'items', index: targetIndex })
    onEmit({ type: 'reorder', sourceId, sourceIndex, targetIndex })
  }

  const renderItems = (): React.ReactNode => {
    if (items.length === 0) return null
    if (spec.reorder) {
      return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            {items.map((it, index) => (
              <SortableRow
                key={it.id}
                item={it}
                selected={it.id === spec.selectedId}
                Icon={Icon}
                sortable={true}
                editable={canEdit}
                deletable={canDelete}
                focused={keyFocus?.zone === 'items' && keyFocus.index === index}
                keyboard={!!spec.keyboard}
                digit={DIGITS[index]}
                onEmit={onEmit}
              />
            ))}
          </SortableContext>
        </DndContext>
      )
    }
    return items.map((it, index) => (
      <SortableRow
        key={it.id}
        item={it}
        selected={it.id === spec.selectedId}
        Icon={Icon}
        sortable={false}
        editable={canEdit}
        deletable={canDelete}
        focused={keyFocus?.zone === 'items' && keyFocus.index === index}
        keyboard={!!spec.keyboard}
        digit={DIGITS[index]}
        onEmit={onEmit}
      />
    ))
  }

  return (
    <div
      ref={ref}
      className="min-w-[220px] max-w-[360px] bg-popover border border-border rounded-lg shadow-lg overflow-hidden text-xs"
    >
      {spec.header && (
        <>
          <div className="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground truncate">
            {spec.header}
          </div>
          <div className="h-px bg-border" />
        </>
      )}
      {colors.length > 0 && (
        <>
          <ColorStrip
            colors={colors}
            selected={spec.selectedColor}
            focusedIndex={keyFocus?.zone === 'colors' ? keyFocus.index : null}
            onEmit={onEmit}
          />
          <div className="h-px bg-border" />
        </>
      )}
      {renderItems()}
      {spec.newAction && (
        <>
          {items.length > 0 && <div className="h-px bg-border" />}
          <button
            {...(keyFocus?.zone === 'new' ? { 'data-key-focus': '' } : {})}
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary hover:bg-accent/50 ${
              keyFocus?.zone === 'new' ? 'bg-accent' : ''
            }`}
            onClick={() => onEmit({ type: 'new' })}
          >
            <Plus size={12} />
            <span className="flex-1">{spec.newAction.label}</span>
            {spec.keyboard && rowKeys && <kbd className="font-mono text-muted-foreground">{ROW_KEYS.new}</kbd>}
          </button>
        </>
      )}
      {actions.length > 0 && (
        <>
          {(items.length > 0 || spec.newAction) && <div className="h-px bg-border" />}
          {actions.map((action, idx) => (
            <div key={action.id}>
              {action.divider === 'before' && idx > 0 && <div className="border-t border-border" />}
              <ActionRow
                action={action}
                focused={keyFocus?.zone === 'actions' && keyFocus.index === idx}
                menuKey={keys.get(idx)}
                onEmit={onEmit}
              />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
