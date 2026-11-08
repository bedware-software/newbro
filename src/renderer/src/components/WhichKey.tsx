// Which-key's strip (lib/which-key.ts): what can follow a pending prefix,
// along the bottom of the page area — beside the Sidebar too, whose own
// hint bar keeps to the Sidebar's keys.

import { useEffect, useState } from 'react'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { HintBar, WhichKeyHints } from './KeyHints'
import type { VimKeymap } from '../lib/vim-keymap'
import { useWhichKey, type WhichKeyEntry } from '../lib/which-key'
import { log } from '../lib/log'

const STRIP_ROW_HEIGHT = 40
// Wrapped (py-2, gap-y-1.5): two rows in 64, each row more 25 — a cap's
// 19 px and the gap.
const STRIP_TWO_ROWS_HEIGHT = 64
const STRIP_MORE_ROW_HEIGHT = 25

/** Roughly how many rows the strip's items take in `width` — 11 px text, a
 *  cap per entry, the bar's gaps and padding — laid out as the bar wraps
 *  them: an item that doesn't fit starts the next row. Beside the Sidebar
 *  and the Bookshelf the page area can be narrow enough for three. */
function stripRows(pending: string, entries: WhichKeyEntry[], width: number): number {
  const text = (s: string): number => s.length * 6.5
  const cap = (s: string): number => text(s) + 12
  const gap = 12
  const room = width - 32
  const items = [cap(pending) + 14, ...entries.map((entry) => text(entry.label) + 4 + cap(entry.keys))]
  let rows = 1
  let used = 0
  for (const item of items) {
    if (used > 0 && used + gap + item > room) {
      rows++
      used = item
    } else {
      used += (used > 0 ? gap : 0) + item
    }
  }
  return rows
}

/**
 * The strip: a popup along the bottom of the page area (`anchorRef`), over
 * the page and beside the Sidebar when it's shown, shown without taking the
 * keyboard — the keys stay wherever they were typed. `keymap` null: nothing
 * to show (Vim mode off).
 */
export function WhichKeyStrip({ keymap, pending, anchorRef }: {
  keymap: VimKeymap | null
  pending: string
  anchorRef: React.RefObject<HTMLElement | null>
}) {
  const entries = useWhichKey(keymap, pending)
  const open = entries.length > 0
  const [box, setBox] = useState<{ placement: PopupPlacement; width: number; height: number } | null>(null)
  // Bumped as the window changes size while the strip is up.
  const [resized, setResized] = useState(0)
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setResized((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // Measured as it opens, and again as the window changes size: it's up as
  // long as the prefix waits for its next key, which is however long.
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) {
      setBox(null)
      return
    }
    const r = el.getBoundingClientRect()
    const width = Math.max(200, Math.round(r.width))
    const rows = stripRows(pending, entries, width)
    const height = rows === 1 ? STRIP_ROW_HEIGHT : STRIP_TWO_ROWS_HEIGHT + (rows - 2) * STRIP_MORE_ROW_HEIGHT
    setBox((prev) => {
      const next = { placement: { left: Math.round(r.left), top: Math.round(r.bottom - height) }, width, height }
      return prev && prev.width === next.width && prev.height === next.height
        && prev.placement.left === next.placement.left && prev.placement.top === next.placement.top ? prev : next
    })
  }, [open, anchorRef, pending, entries, resized])

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
