import { useEffect, useRef } from 'react'
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
  X, FolderPlus, FolderMinus, FolderInput, Folder, Copy, MessageSquare, MessageSquareOff, FilePlus,
  Pin, PinOff, EyeOff, Puzzle, PanelLeft, PanelLeftClose,
} from 'lucide-react'
import type {
  DropdownAction,
  DropdownEventBody,
  DropdownItem,
  DropdownSpec,
  IconName,
} from './dropdown-protocol'

// String-keyed icon registry. Spec sends icon NAMES (strings) over IPC; the
// popup resolves them here. Keep in sync with IconName in dropdown-protocol.ts.
const ICONS: Record<IconName, typeof User> = {
  User, Layout, Search, Settings, Download, Info, LogOut, Plus, Pencil, Trash2, Menu, Globe, Import,
  X, FolderPlus, FolderMinus, FolderInput, Folder, Copy, MessageSquare, MessageSquareOff, FilePlus,
  Pin, PinOff, EyeOff, Puzzle, PanelLeft, PanelLeftClose,
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

function ActionRow({ action, onEmit }: { action: DropdownAction; onEmit: (evt: DropdownEventBody) => void }) {
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
          : `hover:bg-accent ${action.destructive ? 'text-destructive' : ''}`
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
      {spec.actions && spec.actions.length > 0 && (
        <>
          {(items.length > 0 || spec.newAction) && <div className="h-px bg-border" />}
          {spec.actions.map((action, idx) => (
            <div key={action.id}>
              {action.divider === 'before' && idx > 0 && <div className="border-t border-border" />}
              <ActionRow action={action} onEmit={onEmit} />
            </div>
          ))}
        </>
      )}
    </div>
  )
}
