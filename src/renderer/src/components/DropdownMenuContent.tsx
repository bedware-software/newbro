import { useEffect, useRef, useState } from 'react'
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
  FolderOpen, Link, Pause, Play, RotateCw, ListX,
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
  FolderOpen, Link, Pause, Play, RotateCw, ListX,
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
  onEmit,
}: {
  item: DropdownItem
  selected: boolean
  Icon: typeof User
  sortable: boolean
  editable: boolean
  deletable: boolean
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
      className={`flex items-center gap-2 px-3 py-1.5 group/row transition-colors ${
        selected
          ? 'bg-accent text-accent-foreground'
          : 'text-foreground hover:bg-accent/50'
      } ${isDragging ? 'opacity-60' : ''} ${sortable ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      <button
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        onClick={() => onEmit({ type: 'select', id: item.id })}
      >
        <Icon size={12} className="text-muted-foreground shrink-0" />
        <span className="truncate">{item.name}</span>
      </button>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/row:opacity-100 transition-all">
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
      </div>
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

function ActionRow({
  action,
  focused,
  onEmit,
}: {
  action: DropdownAction
  /** Highlighted by keyboard navigation. */
  focused: boolean
  onEmit: (evt: DropdownEventBody) => void
}) {
  const Icon = resolveIcon(action.iconName)
  const disabled = !!action.disabled
  return (
    <button
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
      {action.shortcut && action.shortcut.length > 0 && (
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

  const items = spec.items ?? []
  const Icon = resolveIcon(spec.iconName)
  const actions = spec.actions ?? []
  const colors = spec.colors ?? []

  // Keyboard navigation for menus opened from the keyboard: j/k (or ↓/↑)
  // step through the enabled actions, h/l across the colour swatches, and
  // Enter picks whichever was moved to last.
  const [keyFocus, setKeyFocus] = useState<{ zone: 'actions' | 'colors'; index: number } | null>(null)
  useEffect(() => {
    const first = actions.findIndex((a) => !a.disabled)
    setKeyFocus(spec.keyboard && first !== -1 ? { zone: 'actions', index: first } : null)
  }, [spec])

  useEffect(() => {
    if (!spec.keyboard) return
    const handler = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const enabled = actions.flatMap((a, i) => (a.disabled ? [] : [i]))
      const step = e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0
      if (step !== 0) {
        if (enabled.length === 0) return
        e.preventDefault()
        setKeyFocus((prev) => {
          // Back from the swatches: resume on the action last highlighted.
          if (prev?.zone === 'actions' && enabled.includes(prev.index)) {
            const at = enabled.indexOf(prev.index) + step
            return { zone: 'actions', index: enabled[Math.max(0, Math.min(enabled.length - 1, at))] }
          }
          return { zone: 'actions', index: enabled[0] }
        })
      } else if (e.key === 'h' || e.key === 'l') {
        if (colors.length === 0) return
        e.preventDefault()
        setKeyFocus((prev) => {
          // Entering the strip starts from the group's current colour.
          const from = prev?.zone === 'colors'
            ? prev.index
            : colors.findIndex((c) => c.value.trim().toLowerCase() === spec.selectedColor?.trim().toLowerCase())
          const at = from === -1 ? 0 : from + (e.key === 'l' ? 1 : -1)
          return { zone: 'colors', index: Math.max(0, Math.min(colors.length - 1, at)) }
        })
      } else if (e.key === 'Enter' && keyFocus) {
        e.preventDefault()
        if (keyFocus.zone === 'colors') {
          const color = colors[keyFocus.index]
          if (color) onEmit({ type: 'color', color: color.value })
        } else {
          const action = actions[keyFocus.index]
          if (action && !action.disabled) onEmit({ type: 'action', actionId: action.id })
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [spec, actions, colors, keyFocus, onEmit])

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over) return
    const sourceId = String(active.id)
    const targetId = String(over.id)
    if (sourceId === targetId) return
    const sourceIndex = items.findIndex((it) => it.id === sourceId)
    const targetIndex = items.findIndex((it) => it.id === targetId)
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return
    onEmit({ type: 'reorder', sourceId, sourceIndex, targetIndex })
  }

  const renderItems = (): React.ReactNode => {
    if (items.length === 0) return null
    if (spec.reorder) {
      return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            {items.map((it) => (
              <SortableRow
                key={it.id}
                item={it}
                selected={it.id === spec.selectedId}
                Icon={Icon}
                sortable={true}
                editable={!!spec.editable}
                deletable={!!spec.deletable && !!spec.canDelete}
                onEmit={onEmit}
              />
            ))}
          </SortableContext>
        </DndContext>
      )
    }
    return items.map((it) => (
      <SortableRow
        key={it.id}
        item={it}
        selected={it.id === spec.selectedId}
        Icon={Icon}
        sortable={false}
        editable={!!spec.editable}
        deletable={!!spec.deletable && !!spec.canDelete}
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
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-primary hover:bg-accent/50"
            onClick={() => onEmit({ type: 'new' })}
          >
            <Plus size={12} />
            {spec.newAction.label}
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
                onEmit={onEmit}
              />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
