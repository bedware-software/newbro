// Dark pages — Vimperium's own dark mode for web pages (main/dark-pages.ts runs
// it; the address bar's moon and Settings → Dark pages drive it). Shared so
// main and the renderer decide a page's look the same way.
//
// A page is dark when its site has a rule saying so, or — with no rule — when
// Dark pages is on (`mode`: 'on', or 'theme' while Vimperium's own theme is
// dark). A dark page asks the site for its own dark theme
// (prefers-color-scheme: dark); in the 'smart' style — and on a site the user
// marked Dark — Chromium also darkens whatever the site paints light, at
// paint time, so there's nothing to parse and nothing to flash. The comfort
// sliders tone dark pages down with one filter on the page's root.

import { PSEUDO_FULLSCREEN_ROOT_ATTR } from './page-markers'

export type DarkPagesMode = 'off' | 'on' | 'theme'
export type DarkPagesStyle = 'smart' | 'native'
export type DarkPagesRule = 'dark' | 'light'

export interface DarkPagesConfig {
  /** 'off', 'on', or 'theme' — on while Vimperium's theme is dark. */
  mode: DarkPagesMode
  /** 'smart': the site's own dark theme where it has one, Chromium darkens
   *  the rest. 'native': sites' own dark themes only — nothing repainted. */
  style: DarkPagesStyle
  /** Comfort filter on dark pages, in percent (100 = untouched). */
  brightness: number
  contrast: number
  /** Sepia, 0–100. */
  warmth: number
  /** Per-site rules by host (`github.com` covers its subdomains too). */
  sites: Record<string, DarkPagesRule>
}

export const DARK_PAGES_LIMITS = {
  brightness: { min: 50, max: 150, default: 100 },
  contrast: { min: 50, max: 150, default: 100 },
  warmth: { min: 0, max: 100, default: 0 },
} as const

export const DEFAULT_DARK_PAGES: DarkPagesConfig = {
  mode: 'off',
  style: 'smart',
  brightness: DARK_PAGES_LIMITS.brightness.default,
  contrast: DARK_PAGES_LIMITS.contrast.default,
  warmth: DARK_PAGES_LIMITS.warmth.default,
  sites: {},
}

const MAX_SITES = 2000
const MAX_HOST_LENGTH = 253

function clampPercent(raw: unknown, limits: { min: number; max: number; default: number }): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : limits.default
  return Math.min(limits.max, Math.max(limits.min, n))
}

/** A site key as typed or stored: lower case, no scheme, path, port or
 *  leading `www.`. Null when nothing host-like is left. */
export function normalizeSiteKey(raw: string): string | null {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  // Accept a pasted address: keep its host.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname } catch { return null }
  }
  s = s.replace(/[/?#].*$/, '')
  // Drop a port, but not an IPv6 literal's colons.
  if (!s.startsWith('[')) s = s.replace(/:\d+$/, '')
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '')
  if (!s || s.length > MAX_HOST_LENGTH) return null
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/.test(s)) return null
  return s
}

/** Valid, complete config from anything stored or synced. */
export function normalizeDarkPages(raw: unknown): DarkPagesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DarkPagesConfig, unknown>>
  const sites: Record<string, DarkPagesRule> = {}
  if (r.sites && typeof r.sites === 'object') {
    for (const [key, rule] of Object.entries(r.sites as Record<string, unknown>)) {
      if (Object.keys(sites).length >= MAX_SITES) break
      const host = normalizeSiteKey(key)
      if (host && (rule === 'dark' || rule === 'light')) sites[host] = rule
    }
  }
  return {
    mode: r.mode === 'on' || r.mode === 'theme' ? r.mode : 'off',
    style: r.style === 'native' ? 'native' : 'smart',
    brightness: clampPercent(r.brightness, DARK_PAGES_LIMITS.brightness),
    contrast: clampPercent(r.contrast, DARK_PAGES_LIMITS.contrast),
    warmth: clampPercent(r.warmth, DARK_PAGES_LIMITS.warmth),
    sites,
  }
}

/** Schemes whose pages Dark pages leaves alone: DevTools, Chromium's own and
 *  our internal pages, under their old `newbro:` scheme too (saved tabs and
 *  devices still on Newbro keep it, see renderer lib/internal-pages.ts). */
const UNTOUCHED_SCHEMES = new Set(['devtools:', 'chrome:', 'chrome-untrusted:', 'chrome-search:', 'vimperium:', 'newbro:'])

/** Whether Dark pages acts on a page at this address at all. */
export function darkPagesApplies(url: string): boolean {
  if (!url) return true
  try { return !UNTOUCHED_SCHEMES.has(new URL(url).protocol) } catch { return true }
}

/** The key a site rule for this page goes under: its host, less `www.` —
 *  null for pages with no site to speak of (blank, files, data:, extension
 *  pages), which only follow the global switch. */
export function siteKeyOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol)) return null
    return normalizeSiteKey(u.hostname)
  } catch {
    return null
  }
}

/** The rule that applies to a page — its host's, or the closest parent
 *  domain's — and the key it's stored under. */
export function siteRuleFor(config: DarkPagesConfig, url: string): { site: string; rule: DarkPagesRule } | null {
  const host = siteKeyOf(url)
  if (!host) return null
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) {
    const rule = config.sites[host]
    return rule ? { site: host, rule } : null
  }
  const labels = host.split('.')
  for (let i = 0; i < labels.length; i++) {
    const site = labels.slice(i).join('.')
    const rule = config.sites[site]
    if (rule) return { site, rule }
  }
  return null
}

/** Dark pages switched on for every page right now (sites' rules aside). */
export function darkPagesGloballyOn(config: DarkPagesConfig, appDark: boolean): boolean {
  return config.mode === 'on' || (config.mode === 'theme' && appDark)
}

/** How a page at this address looks: `dark` — dark at all (the site is asked
 *  for its own dark theme); `repaint` — Chromium darkens what it paints
 *  light; `rule` — the site rule that decided it, if any. */
export interface DarkPageLook {
  dark: boolean
  repaint: boolean
  rule: DarkPagesRule | null
}

export function darkPageLook(config: DarkPagesConfig, url: string, appDark: boolean): DarkPageLook {
  if (!darkPagesApplies(url)) return { dark: false, repaint: false, rule: null }
  const rule = siteRuleFor(config, url)?.rule ?? null
  const dark = rule ? rule === 'dark' : darkPagesGloballyOn(config, appDark)
  // A site marked Dark is darkened even when the style leaves the rest to
  // the sites' own themes: that's what marking it asks for.
  return { dark, repaint: dark && (config.style === 'smart' || rule === 'dark'), rule }
}

/** Whether any page could be dark: Dark pages on, or a site marked Dark. */
export function darkPagesInUse(config: DarkPagesConfig, appDark: boolean): boolean {
  return darkPagesGloballyOn(config, appDark) || Object.values(config.sites).includes('dark')
}

/** The comfort filter (brightness, contrast, warmth) as CSS, or '' when the
 *  sliders are all at rest. It goes on the root — the whole page, its canvas
 *  and its frames — but not while a video plays in Vimperium's stand-in
 *  fullscreen (src/preload/webview-stealth.ts), nor on paper. */
export function comfortCss(config: DarkPagesConfig): string {
  const parts: string[] = []
  if (config.brightness !== 100) parts.push(`brightness(${config.brightness / 100})`)
  if (config.contrast !== 100) parts.push(`contrast(${config.contrast / 100})`)
  if (config.warmth !== 0) parts.push(`sepia(${config.warmth / 100})`)
  if (parts.length === 0) return ''
  return `@media screen { html:not([${PSEUDO_FULLSCREEN_ROOT_ATTR}]) { filter: ${parts.join(' ')} !important; } }`
}

/** The media feature main's session emulates on every page it looks after
 *  (main/dark-pages.ts), as a sign the session is there: no page sees a
 *  rec2020 gamut on its own. */
export const SESSION_MARKER = { name: 'color-gamut', value: 'rec2020' } as const

/** The stylesheet a dark page's document gets as it starts: the comfort
 *  filter, then a guard. Leaving for another site, a page hands its DevTools
 *  session to the next one's renderer before that one has painted, and
 *  losing it the page drops its dark look — it would show light for a
 *  moment. The marker goes with the session, and without it the guard turns
 *  the page black instead, in the same frame. Same specificity as the comfort
 *  rule, and after it, so it wins. */
export function darkPageCss(config: DarkPagesConfig, look: DarkPageLook): string {
  if (!look.dark) return ''
  const guard = `@media screen and (not (${SESSION_MARKER.name}: ${SESSION_MARKER.value})) { `
    + `html:not([${PSEUDO_FULLSCREEN_ROOT_ATTR}]), html[${PSEUDO_FULLSCREEN_ROOT_ATTR}] { filter: brightness(0.07) !important; } }`
  return [comfortCss(config), guard].filter(Boolean).join('\n')
}

/** The site rule that toggles a page: Dark where it's light now, Light where
 *  it's dark — or no rule at all when that's what the global switch does
 *  anyway, so a site toggled twice is back to following it. */
export function toggledSiteRule(config: DarkPagesConfig, url: string, appDark: boolean): { site: string; rule: DarkPagesRule | null } | null {
  const site = siteKeyOf(url)
  if (!site) return null
  const wantDark = !darkPageLook(config, url, appDark).dark
  return { site, rule: siteRuleGiving(config, url, appDark, wantDark) }
}

/** The rule this page's own host needs for the page to be dark (or light):
 *  none when the global switch — or a parent domain's rule, which stays put —
 *  already gives that. */
export function siteRuleGiving(config: DarkPagesConfig, url: string, appDark: boolean, dark: boolean): DarkPagesRule | null {
  const site = siteKeyOf(url)
  if (!site) return null
  const sites = { ...config.sites }
  delete sites[site]
  const inherited = darkPageLook({ ...config, sites }, url, appDark).dark
  return inherited === dark ? null : dark ? 'dark' : 'light'
}
