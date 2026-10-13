// Going to an address the way the address bar's Enter does, for the places
// that take one without it: Vim mode's p / P (the clipboard) and the address
// editor (components/UrlEditor.tsx).

import { useAppStore } from '../store/app-store'
import { normalizeURL } from './url'
import { isInternalUrl } from './internal-pages'
import { log } from './log'

/** Opens `text` — a URL, or a search for anything else — in the active tab
 *  or a new one. Only the first line counts. False when there's nothing to
 *  open. */
export function openAddress(text: string, inNewTab: boolean, why: string): boolean {
  const url = normalizeURL(text.split(/\r?\n/)[0] ?? '')
  if (!url) return false
  const s = useAppStore.getState()
  const tab = s.getActiveTab()
  log.action('open-address', { why, inNewTab, hasTab: !!tab })
  // Parked on a tab group there's no page to replace: open a tab instead.
  if (inNewTab || !tab) {
    if (!s.activeWorkspaceId || isInternalUrl(url)) return false
    s.addTabNearActive(s.activeWorkspaceId, url, true)
    return true
  }
  // Internal pages (newbro://…) have no view to navigate: going to or from
  // one is a store change, and WebviewPanel drops or creates the view.
  if (isInternalUrl(url) || isInternalUrl(tab.url)) {
    s.retargetTab(tab.id, url)
    return true
  }
  window.electronAPI.tabNavigate?.(tab.id, url)
  s.updateTabUrl(tab.id, url)
  return true
}
