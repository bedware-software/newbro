// Opening the pages this window draws in the page area, in place of the
// panels and popups they were: Search Everything (ot ow og op), the keys'
// help (?), the Bookshelf (tb). Each is a tab of its own (vimperium://…,
// lib/internal-pages.ts) — one per workspace, shown again when it's there —
// with the address bar for its filter (lib/address-filter.ts). They open
// at the workspace's top level, and closing one goes back to exactly where
// you were when it opened — a tab, or a group's page parked on.

import { create } from 'zustand'
import { useAppStore } from '../store/app-store'
import type { Workspace } from '../store/types'
import { SEARCH_URL, internalPageOf, isTransientInternalUrl, type InternalPage } from './internal-pages'

/** What Search Everything shows: one kind of thing. */
export type SearchFilter = 'profile' | 'workspace' | 'tabGroup' | 'tab'

/** The last request to open Search Everything: the filter it asked for
 *  (null: the one it showed last), counted so the same one twice is two. */
export const useSearchPageRequest = create<{ filter: SearchFilter | null; v: number }>(() => ({ filter: null, v: 0 }))

/** Where a page's tab was opened from, by the page tab's id: the tab you
 *  were on, or (no tab) the group whose page you were parked on. The tab
 *  history closeTab falls back on never holds a group page, so without this
 *  closing the page would land on some other tab. */
interface Origin { workspaceId: string | null; tabId: string | null; groupId: string | null }
const origins = new Map<string, Origin>()

// Kept up to date on every way of reaching a page's tab — ? / tb / ot, but
// also a Sidebar click, a label, gt, a closed tab falling back on it — so
// closing it goes back to where you came from this time, not the first.
function placeOf(s: ReturnType<typeof useAppStore.getState>): Origin {
  return { workspaceId: s.activeWorkspaceId, tabId: s.activeTabId, groupId: s.activeTabGroupId }
}
let lastPlace = placeOf(useAppStore.getState())
useAppStore.subscribe((s) => {
  const now = placeOf(s)
  if (now.tabId === lastPlace.tabId && now.groupId === lastPlace.groupId && now.workspaceId === lastPlace.workspaceId) return
  const tab = s.activeTabId ? s.getActiveTab() : null
  if (tab && isTransientInternalUrl(tab.url) && lastPlace.tabId !== tab.id && lastPlace.workspaceId === now.workspaceId) {
    origins.set(tab.id, lastPlace)
  }
  lastPlace = now
})

function hasTab(w: Workspace, tabId: string): boolean {
  return !!w.tabs?.some((t) => t.id === tabId) || w.tabGroups.some((g) => g.tabs.some((t) => t.id === tabId))
}

/** Shows `url`'s page (its tab if the workspace has one, a new one at the
 *  top level otherwise), unless you're on it. */
function showPage(url: string): void {
  const s = useAppStore.getState()
  const page = internalPageOf(url)
  if (internalPageOf(s.getActiveTab()?.url) === page) return
  // Where you were is noted as the page comes in front (above).
  s.showInternalPage(url)
}

/** Search Everything, on `filter` (null: the one it showed last), typing. */
export function openSearchPage(filter: SearchFilter | null): void {
  // No workspace, no page: a request nothing answers would make the page
  // take the keyboard whenever it next mounts.
  if (!useAppStore.getState().getActiveWorkspace()) return
  useSearchPageRequest.setState((s) => ({ filter, v: s.v + 1 }))
  showPage(SEARCH_URL)
}

/** Whether the active tab is `page`. */
export function isPageShown(page: InternalPage): boolean {
  return internalPageOf(useAppStore.getState().getActiveTab()?.url) === page
}

/** Closes the active tab when it's `page`: where you were before it shows
 *  again. False when it isn't. */
export function closePage(page: InternalPage): boolean {
  const tab = useAppStore.getState().getActiveTab()
  if (!tab || internalPageOf(tab.url) !== page) return false
  closePageTab(tab.id)
  return true
}

/** Closes a page's tab. In front, it first goes back to where it was opened
 *  from — the tab, or the group page — when that's still in its workspace,
 *  so closeTab has nothing to pick; otherwise closeTab picks (the tab used
 *  last). Not in front (a result picked and shown first), what's shown
 *  stays. */
export function closePageTab(tabId: string): void {
  const from = origins.get(tabId)
  origins.delete(tabId)
  const s = useAppStore.getState()
  const w = s.getActiveWorkspace()
  if (from && w && s.activeTabId === tabId && from.workspaceId === w.id) {
    if (from.tabId) {
      if (from.tabId !== tabId && hasTab(w, from.tabId)) s.setActiveTab(from.tabId)
    } else if (from.groupId && w.tabGroups.some((g) => g.id === from.groupId)) {
      s.setActiveGroup(from.groupId)
    }
  }
  useAppStore.getState().closeTab(tabId)
}

/** Shows `url`'s page, or, on it already, closes it — back to where you
 *  were: ? for the keys, tb for the Bookshelf. */
export function togglePage(url: string): void {
  const page = internalPageOf(url)
  if (page && closePage(page)) return
  showPage(url)
}
