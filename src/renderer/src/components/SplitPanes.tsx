// Split view's page area (lib/split-view.ts): where the two panes go, and
// the chrome drawn around their tab views — a frame per pane (the focused
// one lit), the divider between them, and the empty pane's placeholder while
// the tab picker is up. The tab views are native and paint over all of this,
// so only the frames and the divider show around them.

import type { RefObject } from 'react'
import { Columns2, Rows2 } from 'lucide-react'
import type { SplitDirection, SplitView } from '../lib/split-view'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The divider between the panes. */
export const SPLIT_GAP = 6
/** The frame around each pane's page. */
export const SPLIT_FRAME = 2

/** The two panes' rects inside `area`: first (left / top), then second. */
export function splitPaneRects(area: Rect, direction: SplitDirection, ratio: number): [Rect, Rect] {
  if (direction === 'right') {
    const first = Math.round((area.width - SPLIT_GAP) * ratio)
    return [
      { x: area.x, y: area.y, width: first, height: area.height },
      { x: area.x + first + SPLIT_GAP, y: area.y, width: Math.max(0, area.width - first - SPLIT_GAP), height: area.height },
    ]
  }
  const first = Math.round((area.height - SPLIT_GAP) * ratio)
  return [
    { x: area.x, y: area.y, width: area.width, height: first },
    { x: area.x, y: area.y + first + SPLIT_GAP, width: area.width, height: Math.max(0, area.height - first - SPLIT_GAP) },
  ]
}

/** Where a pane's tab view goes: inside its frame. */
export function insetForFrame(r: Rect): Rect {
  return {
    x: r.x + SPLIT_FRAME,
    y: r.y + SPLIT_FRAME,
    width: Math.max(0, r.width - SPLIT_FRAME * 2),
    height: Math.max(0, r.height - SPLIT_FRAME * 2),
  }
}

/** The glyph for a split: a box cut in two, the given pane filled. */
export function SplitGlyph({ direction, pane, className }: { direction: SplitDirection; pane: 'first' | 'second' | null; className?: string }) {
  if (pane === null) {
    const Icon = direction === 'right' ? Columns2 : Rows2
    return <Icon size={13} className={className} />
  }
  const fill = direction === 'right'
    ? { x: pane === 'first' ? 2.5 : 9.2, y: 2.5, width: 4.3, height: 9 }
    : { x: 2.5, y: pane === 'first' ? 2.5 : 8.2, width: 11, height: 3.3 }
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" className={className} aria-hidden>
      <rect x="1" y="1" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {direction === 'right'
        ? <line x1="8" y1="1.5" x2="8" y2="12.5" stroke="currentColor" strokeWidth="1.2" />
        : <line x1="1.5" y1="7" x2="14.5" y2="7" stroke="currentColor" strokeWidth="1.2" />}
      <rect {...fill} rx="0.8" fill="currentColor" />
    </svg>
  )
}

interface FramesProps {
  split: SplitView
  /** The divider's position while it's being dragged. */
  ratio: number
  focusedTabId: string | null
  dragging: boolean
  onDividerMouseDown: (e: React.MouseEvent) => void
  /** The empty pane while the picker is up — the picker centres on it. */
  emptyPaneRef: RefObject<HTMLDivElement | null>
}

export function SplitFrames({ split, ratio, focusedTabId, dragging, onDividerMouseDown, emptyPaneRef }: FramesProps) {
  const right = split.direction === 'right'
  const firstSize = `calc((100% - ${SPLIT_GAP}px) * ${ratio})`
  const secondStart = `calc((100% - ${SPLIT_GAP}px) * ${ratio} + ${SPLIT_GAP}px)`
  const firstStyle: React.CSSProperties = right
    ? { left: 0, top: 0, bottom: 0, width: firstSize }
    : { left: 0, right: 0, top: 0, height: firstSize }
  const dividerStyle: React.CSSProperties = right
    ? { left: firstSize, top: 0, bottom: 0, width: SPLIT_GAP }
    : { top: firstSize, left: 0, right: 0, height: SPLIT_GAP }
  const secondStyle: React.CSSProperties = right
    ? { left: secondStart, top: 0, bottom: 0, right: 0 }
    : { top: secondStart, left: 0, right: 0, bottom: 0 }
  const frame = (tabId: string | null): string =>
    `absolute box-border border-2 ${tabId !== null && tabId === focusedTabId ? 'border-primary/70' : 'border-border'} ${dragging ? 'bg-muted/40' : ''}`

  return (
    <>
      <div className={frame(split.first)} style={firstStyle} />
      <div
        className={`absolute z-10 bg-border hover:bg-primary/50 ${dragging ? 'bg-primary/60' : ''} ${right ? 'cursor-col-resize' : 'cursor-row-resize'}`}
        style={dividerStyle}
        onMouseDown={onDividerMouseDown}
        title="Drag to resize the panes"
      />
      <div ref={split.second === null ? emptyPaneRef : undefined} className={frame(split.second)} style={secondStyle}>
        {split.second === null && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground select-none">
            <SplitGlyph direction={split.direction} pane="second" className="text-muted-foreground/70" />
            <span>Pick a tab for this side — or click one in the sidebar</span>
          </div>
        )}
      </div>
    </>
  )
}
