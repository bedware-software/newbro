// Internal pages: tabs whose URL is `vimperium://<page>`. They never get a
// WebContentsView — WebviewPanel hides the tab views and draws the page in the
// app renderer instead, so it shares the theme, the keyboard handling and the
// IPC surface of the rest of the chrome. Moving a tab between an internal page
// and the web is a store change (retargetTab); WebviewPanel creates or drops
// the tab's view to match.

export type InternalPage = 'downloads' | 'bangs'

export const DOWNLOADS_URL = 'vimperium://downloads'
export const BANGS_URL = 'vimperium://bangs'

/** Tab favicon marker for internal pages. TabFavicon draws the named icon
 *  instead of loading an image. */
export const INTERNAL_ICON_PREFIX = 'vimperium-icon:'

// The app was called Newbro, and so was the scheme: `newbro://downloads`.
// Those URLs are still in saved tabs, in the default-page setting and in the
// state Cloud Sync brings from a device still on Newbro, so they stay
// internal pages for good. Whatever opens one from now on writes it as
// vimperium:// (canonicalInternalUrl). Tabs saved with the old favicon marker
// keep it until they're next pointed somewhere, so TabFavicon reads both.
const LEGACY_INTERNAL_SCHEME = 'newbro://'
const LEGACY_INTERNAL_ICON_PREFIX = 'newbro-icon:'

const INTERNAL_URL = /^(?:vimperium|newbro):\/\/([a-z-]*)/i

const PAGES: Record<InternalPage, { title: string; icon: string }> = {
  downloads: { title: 'Downloads', icon: 'download' },
  bangs: { title: 'Bangs', icon: 'zap' },
}

/** Any vimperium:// (or legacy newbro://) URL — known page or not, it must
 *  never reach a web view. */
export function isInternalUrl(url: string | null | undefined): boolean {
  return !!url && INTERNAL_URL.test(url.trim())
}

/** The internal page a URL points at, or null for web URLs and unknown pages. */
export function internalPageOf(url: string | null | undefined): InternalPage | null {
  if (!url) return null
  const page = INTERNAL_URL.exec(url.trim())?.[1].toLowerCase()
  // Own keys only: `in` would also take vimperium://constructor for a page.
  return page && Object.prototype.hasOwnProperty.call(PAGES, page) ? (page as InternalPage) : null
}

/** The URL with a legacy `newbro://` swapped for `vimperium://`; any other
 *  URL as it is. For every place that points a tab at a URL. */
export function canonicalInternalUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.slice(0, LEGACY_INTERNAL_SCHEME.length).toLowerCase() !== LEGACY_INTERNAL_SCHEME) return url
  return 'vimperium://' + trimmed.slice(LEGACY_INTERNAL_SCHEME.length)
}

/** A copy of a saved workspace tree with every `url` and `favicon` field in
 *  the current form: newbro:// → vimperium://, newbro-icon: →
 *  vimperium-icon:. Run when state is loaded, so a tab saved under Newbro
 *  never shows the old name in the address bar. Devices still on Newbro are
 *  unaffected: Cloud Sync publishes these fields in Newbro's form
 *  (main/ipc.ts withLegacyInternalPages). */
export function withCanonicalInternalPages<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withCanonicalInternalPages) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'url' && typeof field === 'string') out[key] = canonicalInternalUrl(field)
    else if (key === 'favicon' && typeof field === 'string' && field.startsWith(LEGACY_INTERNAL_ICON_PREFIX)) {
      out[key] = INTERNAL_ICON_PREFIX + field.slice(LEGACY_INTERNAL_ICON_PREFIX.length)
    } else out[key] = withCanonicalInternalPages(field)
  }
  return out as T
}

/** The icon name an internal page's favicon marker carries ('download' for
 *  `vimperium-icon:download`, or the legacy `newbro-icon:download`), or null
 *  for a real favicon. */
export function internalIconName(favicon: string | null | undefined): string | null {
  if (!favicon) return null
  for (const prefix of [INTERNAL_ICON_PREFIX, LEGACY_INTERNAL_ICON_PREFIX]) {
    if (favicon.startsWith(prefix)) return favicon.slice(prefix.length)
  }
  return null
}

/** Tab title and favicon marker for an internal URL; null for web URLs. */
export function internalTabMeta(url: string | null | undefined): { title: string; favicon: string } | null {
  if (!isInternalUrl(url)) return null
  const page = internalPageOf(url)
  if (!page) return { title: 'Page not found', favicon: `${INTERNAL_ICON_PREFIX}alert` }
  return { title: PAGES[page].title, favicon: `${INTERNAL_ICON_PREFIX}${PAGES[page].icon}` }
}
