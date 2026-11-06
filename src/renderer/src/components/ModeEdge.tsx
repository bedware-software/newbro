import { useLayoutEffect, useRef } from 'react'
import type { VimMode } from '../lib/vim-mode'
import { useVimEdge, useVimEdgeEverywhere, type VimEdge } from '../lib/vim-edge'

interface Props {
  /** Null while Vim mode is off: no edge. */
  mode: VimMode | null
  /** The look, when not the one chosen in Settings (Settings' previews). */
  edge?: VimEdge
  /** The address bar's, shown by default; any other field's only while
   *  Settings asks for it on every field. */
  addressBar?: boolean
}

/** Vim's mode as a light moving round the edge of the field it's put in —
 *  the address bar, InputField — in the mode's colours, the way Settings →
 *  Appearance says (.mode-edge in globals.css). The field must be
 *  positioned and must not clip what spills past it. A layer per mode, both
 *  running; the mode's layer shows, the change crossfading. */
export function ModeEdge({ mode, edge, addressBar = false }: Props) {
  const chosen = useVimEdge()
  const everywhere = useVimEdgeEverywhere()
  const look = edge ?? chosen
  const shown = mode !== null && look !== 'off' && (addressBar || everywhere || edge !== undefined)
  const ref = useRef<HTMLSpanElement>(null)

  // The layers cut the field's own shape out of themselves, so they need
  // its radius — whatever the field's classes make it.
  useLayoutEffect(() => {
    const el = ref.current
    const field = el?.parentElement
    if (!el || !field) return
    const radius = parseFloat(getComputedStyle(field).borderTopLeftRadius) || 0
    el.style.setProperty('--r', `${radius}px`)
  }, [look, shown])

  if (!shown) return null
  return (
    <span ref={ref} className="mode-edge" data-edge={look} aria-hidden="true">
      {(['command', 'insert'] as const).map((layer) => (
        <span key={layer} data-for={layer} data-on={mode === layer ? '' : undefined}>
          <i><i /></i>
          <i><i /></i>
        </span>
      ))}
    </span>
  )
}
