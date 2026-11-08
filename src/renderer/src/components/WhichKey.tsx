// Which-key's strip (lib/which-key.ts): what can follow a pending prefix,
// along the bottom of the page area while the Sidebar — which otherwise
// lists it at its foot — is hidden.

import { useEffect, useState } from 'react'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { HintBar, WhichKeyHints } from './KeyHints'
import type { VimKeymap } from '../lib/vim-keymap'
import { useWhichKey, type WhichKeyEntry } from '../lib/which-key'
import { log } from '../lib/log'

const STRIP_ROW_HEIGHT = 40
const STRIP_TWO_ROWS_HEIGHT = 64

/** Roughly how wide the strip's items are, to know whether one row holds
 *  them: 11 px text, a cap per entry, the bar's gaps and padding. */
function stripWidth(pending: string, entries: WhichKeyEntry[]): number {
  const text = (s: string): number => s.length * 6.5
  const cap = (s: string): number => text(s) + 12
  const gap = 12
  let width = 32 + cap(pending) + 14 + gap
  for (const entry of entries) width += text(entry.label) + 4 + cap(entry.keys) + gap
  return width
}

/**
 * The strip, for a hidden Sidebar: a popup along the bottom of the page area
 * (`anchorRef`), over the page, shown without taking the keyboard — the keys
 * stay wherever they were typed. `keymap` null: nothing to show (Vim mode
 * off, or the Sidebar shows it).
 */
export function WhichKeyStrip({ keymap, pending, anchorRef }: {
  keymap: VimKeymap | null
  pending: string
  anchorRef: React.RefObject<HTMLElement | null>
}) {
  const entries = useWhichKey(keymap, pending)
  const open = entries.length > 0
  const [box, setBox] = useState<{ placement: PopupPlacement; width: number; height: number } | null>(null)

  // Measured as it opens; it's up for a second at most, so it doesn't
  // follow the window's size while up.
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) {
      setBox(null)
      return
    }
    const r = el.getBoundingClientRect()
    const width = Math.max(200, Math.round(r.width))
    const height = stripWidth(pending, entries) > width ? STRIP_TWO_ROWS_HEIGHT : STRIP_ROW_HEIGHT
    setBox((prev) => {
      const next = { placement: { left: Math.round(r.left), top: Math.round(r.bottom - height) }, width, height }
      return prev && prev.width === next.width && prev.height === next.height
        && prev.placement.left === next.placement.left && prev.placement.top === next.placement.top ? prev : next
    })
  }, [open, anchorRef, pending, entries])

  if (!open || !box) return null
  return (
    <DetachedWindow
      open
      title="Keys"
      width={box.width}
      height={box.height}
      resizable={false}
      activate={false}
      placement={box.placement}
      // It goes with the pending keys; a close from elsewhere leaves
      // nothing to tidy up.
      onClose={() => log.debug('which-key: strip closed')}
    >
      <HintBar wrap={box.height > STRIP_ROW_HEIGHT} className="h-full">
        <WhichKeyHints pending={pending} entries={entries} />
      </HintBar>
    </DetachedWindow>
  )
}
