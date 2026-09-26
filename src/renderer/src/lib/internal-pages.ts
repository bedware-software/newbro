// Internal pages: tabs whose URL is `newbro://<page>`. They never get a
// WebContentsView — WebviewPanel hides the tab views and draws the page in the
// app renderer instead, so it shares the theme, the keyboard handling and the
// IPC surface of the rest of the chrome. Moving a tab between an internal page
// and the web is a store change (retargetTab); WebviewPanel creates or drops
// the tab's view to match.

export type InternalPage = 'downloads'

export const DOWNLOADS_URL = 'newbro://downloads'

/** Tab favicon marker for internal pages. TabFavicon draws the named icon
 *  instead of loading an image. */
export const INTERNAL_ICON_PREFIX = 'newbro-icon:'

const PAGES: Record<InternalPage, { title: string; icon: string }> = {
  downloads: { title: 'Downloads', icon: 'download' },
}

/** Any newbro:// URL — known page or not, it must never reach a web view. */
export function isInternalUrl(url: string | null | undefined): boolean {
  return !!url && /^newbro:\/\//i.test(url.trim())
}

/** The internal page a URL points at, or null for web URLs and unknown pages. */
export function internalPageOf(url: string | null | undefined): InternalPage | null {
  if (!isInternalUrl(url)) return null
  const m = /^newbro:\/\/([a-z-]+)/i.exec(url!.trim())
  const page = m?.[1].toLowerCase()
  return page && page in PAGES ? (page as InternalPage) : null
}

/** Tab title and favicon marker for an internal URL; null for web URLs. */
export function internalTabMeta(url: string | null | undefined): { title: string; favicon: string } | null {
  if (!isInternalUrl(url)) return null
  const page = internalPageOf(url)
  if (!page) return { title: 'Page not found', favicon: `${INTERNAL_ICON_PREFIX}alert` }
  return { title: PAGES[page].title, favicon: `${INTERNAL_ICON_PREFIX}${PAGES[page].icon}` }
}
