// A query with several bangs, or a label of bangs (shared/bangs.ts):
// `steam deck !avito !ozon`, `steam deck !it-search`. Each site's search
// opens in a tab of its own, all of them in a new tab group named for the
// query, and all of them load at once — not only the one in front, as
// background tabs otherwise wait to be shown.

import { useAppStore } from '../store/app-store'
import { expandBang, type MultiBangHit } from '../../../shared/bangs'
import { isInternalUrl } from './internal-pages'
import { log } from './log'


/** The group's name: the query, else the `!words` that made it. */
export function bangGroupName(hit: MultiBangHit): string {
  return hit.query.trim() || hit.words.join(' ')
}

/** Opens `hit`'s searches in a new group, the first one in front (unless
 *  `activate` is false: a background open). `reuseTabId`:
 *  a tab to put the first search in (a new tab's, typed into) rather than
 *  open one more; null opens them all in new tabs. */
export function openBangGroup(hit: MultiBangHit, reuseTabId: string | null, activate = true): void {
  const s = useAppStore.getState()
  const ws = s.activeWorkspaceId
  if (!ws) return
  const urls = hit.bangs.map((b) => expandBang(b, hit.query))
  log.action('multi-bang', { bangs: hit.bangs.map((b) => b.trigger), reuse: !!reuseTabId })
  const ids: string[] = []
  let rest = urls
  if (reuseTabId) {
    const tab = s.getActiveTab()
    if (tab && tab.id === reuseTabId) {
      const first = urls[0]
      if (isInternalUrl(tab.url)) s.retargetTab(tab.id, first)
      else {
        window.electronAPI.tabNavigate?.(tab.id, first)
        s.updateTabUrl(tab.id, first)
      }
      ids.push(tab.id)
      rest = urls.slice(1)
    }
  }
  // In the background: each starts loading now (the store marks them to).
  for (const url of rest) {
    const id = useAppStore.getState().addTabNearActive(ws, url, false)
    if (id) ids.push(id)
  }
  if (ids.length === 0) return
  useAppStore.getState().groupTabsInNewGroup(ids, bangGroupName(hit))
  if (activate) useAppStore.getState().setActiveTab(ids[0])
}
