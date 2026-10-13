// Where a popup pinned to a corner of the page area goes (DetachedWindow's
// `placement`): Find in Page in the top-right corner, page prompts in the
// top-left one. Follows the page area as the window and the panels around
// it change size.

import { useEffect, useState } from 'react'
import type { PopupPlacement } from '../components/DetachedWindow'

// Inset from the page area's top corner.
const INSET_TOP = 8
const INSET_SIDE = 16

export function usePagePlacement(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  corner: 'left' | 'right',
  width: number,
): PopupPlacement | undefined {
  const [placement, setPlacement] = useState<PopupPlacement>()
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const left = corner === 'left'
        ? r.left + INSET_SIDE
        : Math.max(r.left, r.right - width - INSET_SIDE)
      const next = { left: Math.round(left), top: Math.round(r.top + INSET_TOP) }
      setPlacement((prev) => (prev?.left === next.left && prev.top === next.top ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, corner, width])
  return open ? placement : undefined
}
