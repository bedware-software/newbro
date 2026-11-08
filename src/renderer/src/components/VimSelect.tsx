// A drop-down list for Settings in place of a native <select>, whose own
// pop-up takes no keys but the arrows: a button showing the choice, and a
// list under it. The keys, Vim's or not, are the same everywhere:
//   closed  Enter / Space / ↓ open it; with Vim's form keys (lib/vim-form.ts)
//           h / l pick the previous or next choice without opening it
//   open    j / k or ↓ / ↑ move, Enter or Space picks, Esc closes; out of
//           Vim mode a letter goes to the first choice starting with it
// A press outside, the window losing focus or the form scrolling closes it.

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'
import { VimFormContext, setItemStepper, stepIndex } from '../lib/vim-form'

export interface VimSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface Props<T extends string> {
  value: T
  options: ReadonlyArray<VimSelectOption<T>>
  onChange: (value: T) => void
  /** What's being chosen, for screen readers. */
  label: string
  title?: string
  disabled?: boolean
  /** Its data-vim-item id, for Vim's form keys. */
  vimItem?: string
  /** The button's size and look (h-8 px-2.5 text-xs field rounded-lg…). */
  className?: string
}

interface Placement {
  left: number
  top?: number
  bottom?: number
  minWidth: number
  maxWidth: number
  maxHeight: number
}

const OPTION_PX = 28
const LIST_MAX_PX = 280

export function VimSelect<T extends string>({ value, options, onChange, label, title, disabled = false, vimItem, className }: Props<T>) {
  const form = useContext(VimFormContext)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActiveState] = useState(0)
  // The highlighted choice as of the last key, ahead of the render — a key
  // repeating faster than renders still picks the one it moved to.
  const activeRef = useRef(0)
  const setActive = (index: number): void => {
    activeRef.current = index
    setActiveState(index)
  }
  const [placement, setPlacement] = useState<Placement | null>(null)
  const chosen = options.find((o) => o.value === value)

  const enabledIndexes = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)

  // The latest of everything, for the handlers registered once.
  const latest = useRef({ value, options, onChange, enabledIndexes })
  latest.current = { value, options, onChange, enabledIndexes }

  const choose = (index: number): void => {
    const { options: list, value: current, onChange: change } = latest.current
    const option = list[index]
    if (!option || option.disabled) return
    if (option.value !== current) change(option.value)
  }

  /** `delta` choices on from `from` among the enabled ones. */
  const stepFrom = (from: number, delta: number): number => {
    const enabled = latest.current.enabledIndexes
    const next = enabled[stepIndex(enabled.indexOf(from), enabled.length, delta, false)]
    return next ?? from
  }

  const close = (giveBackFocus: boolean): void => {
    setOpen(false)
    // Out of Vim mode the keyboard goes back to the button; in it, the
    // keyboard was never anywhere but the form's window.
    if (giveBackFocus && !form) triggerRef.current?.focus()
  }

  const openList = (): void => {
    if (disabled) return
    const at = options.findIndex((o) => o.value === value)
    setActive(at >= 0 && !options[at].disabled ? at : enabledIndexes[0] ?? 0)
    setOpen(true)
  }

  const pick = (index: number): void => {
    choose(index)
    close(true)
  }

  // h / l on the closed list.
  useEffect(() => {
    const el = triggerRef.current
    if (!el) return
    setItemStepper(el, (delta) => {
      const { options: list, value: current } = latest.current
      choose(stepFrom(list.findIndex((o) => o.value === current), delta))
    })
    return () => setItemStepper(el, null)
    // The stepper reads `latest`, so it's set once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Under the button, or over it when there's more room above.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const trigger = triggerRef.current
    const win = trigger?.ownerDocument.defaultView
    if (!trigger || !win) return
    const rect = trigger.getBoundingClientRect()
    const below = win.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const wanted = Math.min(options.length * OPTION_PX + 10, LIST_MAX_PX)
    const up = below < wanted && above > below
    setPlacement({
      left: rect.left,
      top: up ? undefined : rect.bottom + 4,
      bottom: up ? win.innerHeight - rect.top + 4 : undefined,
      minWidth: rect.width,
      maxWidth: Math.max(rect.width, win.innerWidth - rect.left - 8),
      maxHeight: Math.max(OPTION_PX * 3, Math.min(LIST_MAX_PX, up ? above : below)),
    })
  }, [open, options.length])

  useEffect(() => {
    if (open && placement) listRef.current?.focus({ preventScroll: true })
  }, [open, placement])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active, placement])

  // A press outside, the form scrolling under it, the window losing focus.
  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const doc = trigger?.ownerDocument
    const win = doc?.defaultView
    if (!trigger || !doc || !win) return
    const inside = (target: EventTarget | null): boolean => {
      const node = target as Node | null
      return !!node && (trigger.contains(node) || !!listRef.current?.contains(node))
    }
    const onPress = (e: MouseEvent): void => { if (!inside(e.target)) setOpen(false) }
    const onScroll = (e: Event): void => { if (!listRef.current?.contains(e.target as Node | null)) setOpen(false) }
    const onAway = (): void => setOpen(false)
    doc.addEventListener('mousedown', onPress, true)
    doc.addEventListener('scroll', onScroll, true)
    win.addEventListener('blur', onAway)
    win.addEventListener('resize', onAway)
    return () => {
      doc.removeEventListener('mousedown', onPress, true)
      doc.removeEventListener('scroll', onScroll, true)
      win.removeEventListener('blur', onAway)
      win.removeEventListener('resize', onAway)
    }
  }, [open])

  // Vim's form keys go to the open list.
  useEffect(() => {
    if (!open || !form) return
    return form.openOverlay({
      command: (command) => {
        const at = activeRef.current
        switch (command) {
          case 'cursor-down':
          case 'value-next':
            setActive(stepFrom(at, 1))
            break
          case 'cursor-up':
          case 'value-prev':
            setActive(stepFrom(at, -1))
            break
          case 'half-page-down':
          case 'value-next-big':
            setActive(stepFrom(at, 5))
            break
          case 'half-page-up':
          case 'value-prev-big':
            setActive(stepFrom(at, -5))
            break
          case 'cursor-first':
            setActive(latest.current.enabledIndexes[0] ?? at)
            break
          case 'cursor-last':
            setActive(latest.current.enabledIndexes[latest.current.enabledIndexes.length - 1] ?? at)
            break
          case 'activate':
          case 'toggle':
            pick(at)
            break
        }
        // Whatever else the form's keys would do waits till the list closes.
        return true
      },
      escape: () => close(true),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form])

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openList()
    }
  }

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const at = activeRef.current
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(stepFrom(at, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const enabled = latest.current.enabledIndexes
      setActive((e.key === 'Home' ? enabled[0] : enabled[enabled.length - 1]) ?? at)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(at)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      // Esc closes the list, not the window it's in.
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const letter = e.key.toLowerCase()
      const order = [...options.keys()].map((i) => (at + 1 + i) % options.length)
      const next = order.find((i) => !options[i].disabled && options[i].label.toLowerCase().startsWith(letter))
      if (next !== undefined) setActive(next)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        data-vim-item={vimItem}
        data-vim-kind="select"
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'inline-flex min-w-0 items-center justify-between gap-2 text-left text-foreground outline-none disabled:opacity-50 disabled:cursor-not-allowed',
          className,
        )}
      >
        <span className="truncate">{chosen?.label ?? ''}</span>
        <ChevronDown size={13} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && placement && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={onListKeyDown}
          className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
          style={placement}
        >
          {options.map((option, i) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              data-active={i === active ? '' : undefined}
              onMouseEnter={() => { if (!option.disabled) setActive(i) }}
              // The list keeps the keyboard while it's pressed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              className={cn(
                'flex h-7 cursor-default select-none items-center gap-2 rounded-md px-2 text-xs',
                i === active && 'bg-accent text-accent-foreground',
                option.disabled && 'opacity-50',
              )}
            >
              <Check size={12} className={cn('shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')} />
              <span className="truncate">{option.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
