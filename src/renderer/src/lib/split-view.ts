// Split view: two tabs of the window's workspace side by side (or one over
// the other) in the page area. Window-local and not saved — like Chrome's
// and Arc's split view it's a way of looking at two tabs, not a place tabs
// live: both stay where they are in the sidebar, which marks the pair.
//
// The split shows while its focused pane's tab is the active one; going to
// any other tab shows that tab alone, and coming back to either of the pair
// brings the split back. Focus moves between the panes by making the other
// pane's tab the active one — main keeps both views on screen (see
// setWindowSplit in src/main/tab-views.ts), so nothing moves.
//
// Starting a split leaves the second pane empty with a tab picker over it
// (SplitPicker); activating any tab meanwhile — the picker, a sidebar click,
// Ctrl+J — puts that tab there.

import { create } from 'zustand'
import { useAppStore } from '../store/app-store'
import type { Tab } from '../store/types'
import { isInternalUrl } from './internal-pages'
import { log } from './log'

/** Where the second pane opens. */
export type SplitDirection = 'right' | 'down'

export interface SplitView {
  /** First pane (left / top): the tab that was showing when the split began. */
  first: string
  /** Second pane (right / bottom); null while its picker is up. */
  second: string | null
  direction: SplitDirection
  /** The first pane's share of the page area. */
  ratio: number
}

export const MIN_SPLIT_RATIO = 0.15
export const MAX_SPLIT_RATIO = 0.85

interface SplitState {
  split: SplitView | null
}

export const useSplitStore = create<SplitState>(() => ({ split: null }))

function setSplit(split: SplitView | null, why: string): void {
  log.event('split', split ? `${split.direction} ${split.second ? 'pair' : 'picking'}` : 'off', why)
  useSplitStore.setState({ split })
}

/** The active workspace's tabs, sidebar groups included. */
export function workspaceTabs(): Tab[] {
  const ws = useAppStore.getState().getActiveWorkspace()
  if (!ws) return []
  return [...(ws.tabs ?? []), ...ws.tabGroups.flatMap((g) => g.tabs)]
}

/** Whether a split is on screen: the active tab is one of its panes. */
export function isSplitShown(split: SplitView | null, activeTabId: string | null): split is SplitView {
  return !!split && !!activeTabId && (split.first === activeTabId || split.second === activeTabId)
}

/** The pane beside the active one, while the split shows. */
export function otherPaneTab(): string | null {
  const { split } = useSplitStore.getState()
  const active = useAppStore.getState().activeTabId
  if (!isSplitShown(split, active)) return null
  return split.first === active ? split.second : split.first
}

/**
 * Splits the page area: the active tab keeps the first pane, the second
 * opens to the right or below with the tab picker over it. On a split
 * that's showing it turns it the other way instead. False when there's no
 * web page to split (a group, an internal page).
 */
export function startSplit(direction: SplitDirection): boolean {
  const s = useAppStore.getState()
  const active = s.getActiveTab()
  if (!active || isInternalUrl(active.url)) return false
  const { split } = useSplitStore.getState()
  if (isSplitShown(split, active.id)) {
    if (split.direction !== direction) setSplit({ ...split, direction }, 'turn')
    return true
  }
  setSplit({ first: active.id, second: null, direction, ratio: 0.5 }, 'start')
  return true
}

/** Puts `tabId` in the empty pane and gives it the focus. */
export function fillSplit(tabId: string): void {
  const { split } = useSplitStore.getState()
  if (!split || split.second !== null || tabId === split.first) return
  setSplit({ ...split, second: tabId }, 'fill')
  useAppStore.getState().setActiveTab(tabId)
}

/** Ends the split; the focused pane's tab stays on screen. */
export function closeSplit(): void {
  if (useSplitStore.getState().split) setSplit(null, 'close')
}

/** Focus to the other pane. False when no split is showing. */
export function focusOtherPane(): boolean {
  const other = otherPaneTab()
  if (!other) return false
  useAppStore.getState().setActiveTab(other)
  return true
}

export function setSplitRatio(ratio: number): void {
  const { split } = useSplitStore.getState()
  if (!split) return
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
  if (clamped !== split.ratio) useSplitStore.setState({ split: { ...split, ratio: clamped } })
}

// Keep the split honest as tabs come and go: a pane whose tab closed ends
// it, and while the picker is up, activating a tab fills the empty pane —
// or, for anything that can't go there (a group, an internal page), gives
// up on the split.
let lastActive: string | null = null
useAppStore.subscribe((state) => {
  const { split } = useSplitStore.getState()
  const active = state.activeTabId
  const activeChanged = active !== lastActive
  lastActive = active
  if (!split) return
  const ids = new Set(workspaceTabs().map((t) => t.id))
  if (!ids.has(split.first) || (split.second !== null && !ids.has(split.second))) {
    setSplit(null, 'pane closed')
    return
  }
  if (split.second !== null || !activeChanged || active === split.first) return
  const tab = active ? state.getActiveTab() : undefined
  if (!tab || isInternalUrl(tab.url)) {
    setSplit(null, 'picker left')
    return
  }
  setSplit({ ...split, second: tab.id }, 'fill from activation')
})
