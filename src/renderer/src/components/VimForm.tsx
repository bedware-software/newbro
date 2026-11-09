// What a form's Vim keys (lib/vim-form.ts) draw: each control's
// label, vimium-style, at its top-left corner — the part typed so far lit,
// the ones it no longer fits faded — and the hints for the control under
// the cursor, for the form's hint bar.

import { useLayoutEffect, useRef, useState } from 'react'
import { Hint, RowHint, vimKeyCaps } from './KeyHints'
import { useVimFormSnapshot, type VimFormController } from '../lib/vim-form'
import type { VimMode } from '../lib/vim-mode'
import type { VimKeymap } from '../lib/vim-keymap'

interface Spot {
  label: string
  left: number
  top: number
}

function sameSpots(a: readonly Spot[], b: readonly Spot[]): boolean {
  return a.length === b.length && a.every((s, i) => s.label === b[i].label && s.left === b[i].left && s.top === b[i].top)
}

/** The labels, over the form, in COMMAND — none while a list or the
 *  filter's results are open over it. Put it outside the form's root, so
 *  drawing them doesn't count as the form changing. */
export function VimFormLabels({ form, labels, mode, pending }: {
  form: VimFormController
  /** Label i for the form's labelled control i (usePopupHints). */
  labels: readonly string[]
  mode: VimMode | null
  pending?: string
}) {
  const snapshot = useVimFormSnapshot(form)
  const shown = mode === 'command' && !snapshot.overlayOpen && labels.length > 0
  const layerRef = useRef<HTMLDivElement>(null)
  const [spots, setSpots] = useState<Spot[]>([])

  useLayoutEffect(() => {
    if (!shown) {
      setSpots((prev) => (prev.length === 0 ? prev : []))
      return
    }
    const layer = layerRef.current
    const doc = layer?.ownerDocument
    const win = doc?.defaultView
    if (!doc || !win) return
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const next: Spot[] = []
      form.labelTargets().forEach((el, i) => {
        const label = labels[i]
        if (!label || !el.isConnected) return
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return
        // Only where it shows: inside the part of the form that scrolls,
        // for a control in it.
        const clipEl = form.clipFor(el)
        const clip = clipEl
          ? clipEl.getBoundingClientRect()
          : { top: 0, left: 0, bottom: win.innerHeight, right: win.innerWidth }
        if (rect.bottom <= clip.top || rect.top >= clip.bottom || rect.right <= clip.left || rect.left >= clip.right) return
        next.push({
          label,
          left: Math.round(Math.max(clip.left, rect.left - 6)),
          top: Math.round(Math.max(clip.top, rect.top - 7)),
        })
      })
      setSpots((prev) => (sameSpots(prev, next) ? prev : next))
    }
    const schedule = (): void => {
      if (frame === null) frame = win.requestAnimationFrame(measure)
    }
    measure()
    const stopLayout = form.subscribeLayout(schedule)
    doc.addEventListener('scroll', schedule, true)
    win.addEventListener('resize', schedule)
    return () => {
      stopLayout()
      doc.removeEventListener('scroll', schedule, true)
      win.removeEventListener('resize', schedule)
      if (frame !== null && !win.closed) win.cancelAnimationFrame(frame)
    }
  }, [form, shown, labels])

  return (
    <div ref={layerRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-40">
      {shown && spots.map((spot) => (
        <div key={spot.label} className="absolute" style={{ left: spot.left, top: spot.top }}>
          <RowHint mode="command" label={spot.label} pending={pending} />
        </div>
      ))}
    </div>
  )
}

/** The hint bar's hints for the control under the cursor: what h / l,
 *  Enter and a row's keys do to it. What can't be taken back (a danger
 *  button, a row's Remove) is pressed with dd, never Enter. */
export function VimFormCursorHints({ form, keymap }: { form: VimFormController; keymap: VimKeymap | null }) {
  const { kind, cells, danger, cellDanger } = useVimFormSnapshot(form)
  const caps = (...commands: string[]): string[] => vimKeyCaps(keymap, ...commands)
  switch (kind) {
    case 'toggle':
      return <Hint label="Switch" keys={caps('toggle', 'value-prev', 'value-next')} />
    case 'segment':
      return <Hint label="Choose" keys={caps('value-prev', 'value-next')} />
    case 'select':
      return (
        <>
          <Hint label="Choose" keys={caps('value-prev', 'value-next')} />
          <Hint label="List" keys={caps('activate')} />
        </>
      )
    case 'range':
      return (
        <>
          <Hint label="Slide" keys={caps('value-prev', 'value-next')} />
          <Hint label="By ten" keys={caps('value-prev-big', 'value-next-big')} />
        </>
      )
    case 'text':
      return <Hint label="Type" keys={caps('insert-mode')} />
    case 'button':
      return <Hint label="Press" keys={caps(danger ? 'row-remove' : 'activate')} />
    case 'row':
      return (
        <>
          {cells.length > 1 && <Hint label="Button" keys={caps('value-prev', 'value-next')} />}
          {!danger && !cellDanger && <Hint label="Press" keys={caps('activate')} />}
          {(cells.includes('remove') || cellDanger) && <Hint label="Remove" keys={caps('row-remove')} />}
          {cells.includes('copy') && <Hint label="Copy" keys={caps('row-copy')} />}
          {cells.includes('copy-password') && <Hint label="Password" keys={caps('row-copy-password')} />}
          {cells.includes('edit') && <Hint label="Edit" keys={caps('row-edit')} />}
        </>
      )
    default:
      return null
  }
}
