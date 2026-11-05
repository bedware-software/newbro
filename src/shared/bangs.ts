// Bangs — DuckDuckGo's `!w vim` shortcuts, resolved inside the browser: a
// `!trigger` anywhere in what's typed into the address bar opens that site's
// search for the rest of the text, with no round trip through a search
// engine. The table lives in main (src/main/bangs-store.ts), seeded with
// DEFAULT_BANGS; the renderer resolves against its copy (lib/bangs.ts), and
// the newbro://bangs page edits it (components/BangsPage.tsx).

export interface Bang {
  /** Stable id. Seeded bangs keep `builtin:<trigger>` even when edited, so
   *  "reset to defaults" and new seeds know which ones they are. */
  id: string
  /** What follows the `!`, lowercase: `w` for `!w`. */
  trigger: string
  name: string
  /** Where it goes: `%s` stands for the query, URL-encoded. Without one the
   *  bang just opens the URL. */
  url: string
  category: string
  enabled: boolean
}

/** The query placeholder in a bang's URL — the same as the search engine's. */
export const BANG_PLACEHOLDER = '%s'

/** Placeholders other tools use, accepted when resolving so a template
 *  pasted from DuckDuckGo's bang list (`{{{s}}}`) works as is. */
const PLACEHOLDERS = /%s|\{\{\{s\}\}\}|\{\{query\}\}/g
const HAS_PLACEHOLDER = /%s|\{\{\{s\}\}\}|\{\{query\}\}/

export const BANG_CATEGORIES = [
  'Search', 'Knowledge', 'Dev', 'Media', 'Shopping', 'Maps', 'Translate', 'AI', 'Other',
] as const

const MAX_TRIGGER_LENGTH = 32
const MAX_NAME_LENGTH = 80
const MAX_CATEGORY_LENGTH = 40
const MAX_URL_LENGTH = 2048
export const MAX_BANGS = 2000

function seed(trigger: string, name: string, url: string, category: string): Bang {
  return { id: `builtin:${trigger}`, trigger, name, url, category, enabled: true }
}

/** The popular ones, DuckDuckGo's triggers where it has them. */
export const DEFAULT_BANGS: readonly Bang[] = [
  // Search
  seed('g', 'Google', 'https://www.google.com/search?q=%s', 'Search'),
  seed('ya', 'Yandex', 'https://yandex.ru/search/?text=%s', 'Search'),
  seed('ddg', 'DuckDuckGo', 'https://duckduckgo.com/?q=%s', 'Search'),
  seed('b', 'Bing', 'https://www.bing.com/search?q=%s', 'Search'),
  seed('gi', 'Google Images', 'https://www.google.com/search?tbm=isch&q=%s', 'Search'),
  seed('yai', 'Yandex Images', 'https://yandex.ru/images/search?text=%s', 'Search'),
  seed('gn', 'Google News', 'https://news.google.com/search?q=%s', 'Search'),
  seed('scholar', 'Google Scholar', 'https://scholar.google.com/scholar?q=%s', 'Search'),
  // Knowledge
  seed('w', 'Wikipedia', 'https://en.wikipedia.org/wiki/Special:Search?search=%s', 'Knowledge'),
  seed('wru', 'Wikipedia (ru)', 'https://ru.wikipedia.org/wiki/Special:Search?search=%s', 'Knowledge'),
  seed('wt', 'Wiktionary', 'https://en.wiktionary.org/wiki/Special:Search?search=%s', 'Knowledge'),
  seed('wa', 'Wolfram|Alpha', 'https://www.wolframalpha.com/input?i=%s', 'Knowledge'),
  seed('imdb', 'IMDb', 'https://www.imdb.com/find/?q=%s', 'Knowledge'),
  seed('ud', 'Urban Dictionary', 'https://www.urbandictionary.com/define.php?term=%s', 'Knowledge'),
  seed('arxiv', 'arXiv', 'https://arxiv.org/search/?query=%s&searchtype=all', 'Knowledge'),
  seed('wayback', 'Wayback Machine', 'https://web.archive.org/web/*/%s', 'Knowledge'),
  // Dev
  seed('gh', 'GitHub', 'https://github.com/search?q=%s', 'Dev'),
  seed('so', 'Stack Overflow', 'https://stackoverflow.com/search?q=%s', 'Dev'),
  seed('mdn', 'MDN Web Docs', 'https://developer.mozilla.org/en-US/search?q=%s', 'Dev'),
  seed('npm', 'npm', 'https://www.npmjs.com/search?q=%s', 'Dev'),
  seed('pypi', 'PyPI', 'https://pypi.org/search/?q=%s', 'Dev'),
  seed('crates', 'crates.io', 'https://crates.io/search?q=%s', 'Dev'),
  seed('godoc', 'Go Packages', 'https://pkg.go.dev/search?q=%s', 'Dev'),
  seed('dockerhub', 'Docker Hub', 'https://hub.docker.com/search?q=%s', 'Dev'),
  seed('caniuse', 'Can I use', 'https://caniuse.com/?search=%s', 'Dev'),
  seed('devdocs', 'DevDocs', 'https://devdocs.io/#q=%s', 'Dev'),
  seed('aw', 'ArchWiki', 'https://wiki.archlinux.org/index.php?search=%s', 'Dev'),
  seed('hn', 'Hacker News', 'https://hn.algolia.com/?q=%s', 'Dev'),
  seed('habr', 'Habr', 'https://habr.com/ru/search/?q=%s', 'Dev'),
  // Media
  seed('yt', 'YouTube', 'https://www.youtube.com/results?search_query=%s', 'Media'),
  seed('r', 'Reddit', 'https://www.reddit.com/search/?q=%s', 'Media'),
  seed('x', 'X (Twitter)', 'https://x.com/search?q=%s', 'Media'),
  seed('spotify', 'Spotify', 'https://open.spotify.com/search/%s', 'Media'),
  seed('kp', 'Kinopoisk', 'https://www.kinopoisk.ru/index.php?kp_query=%s', 'Media'),
  // Shopping
  seed('a', 'Amazon', 'https://www.amazon.com/s?k=%s', 'Shopping'),
  seed('ebay', 'eBay', 'https://www.ebay.com/sch/i.html?_nkw=%s', 'Shopping'),
  seed('ali', 'AliExpress', 'https://www.aliexpress.com/wholesale?SearchText=%s', 'Shopping'),
  seed('ozon', 'Ozon', 'https://www.ozon.ru/search/?text=%s', 'Shopping'),
  seed('wb', 'Wildberries', 'https://www.wildberries.ru/catalog/0/search.aspx?search=%s', 'Shopping'),
  seed('avito', 'Avito', 'https://www.avito.ru/rossiya?q=%s', 'Shopping'),
  // Maps
  seed('gm', 'Google Maps', 'https://www.google.com/maps/search/%s', 'Maps'),
  seed('ym', 'Yandex Maps', 'https://yandex.ru/maps/?text=%s', 'Maps'),
  seed('osm', 'OpenStreetMap', 'https://www.openstreetmap.org/search?query=%s', 'Maps'),
  // Translate
  seed('gt', 'Google Translate', 'https://translate.google.com/?sl=auto&tl=en&text=%s&op=translate', 'Translate'),
  seed('ytr', 'Yandex Translate', 'https://translate.yandex.ru/?text=%s', 'Translate'),
  seed('deepl', 'DeepL', 'https://www.deepl.com/translator#auto/en/%s', 'Translate'),
  // AI
  seed('chatgpt', 'ChatGPT', 'https://chatgpt.com/?q=%s', 'AI'),
  seed('claude', 'Claude', 'https://claude.ai/new?q=%s', 'AI'),
  seed('pplx', 'Perplexity', 'https://www.perplexity.ai/search?q=%s', 'AI'),
  // Other
  seed('gd', 'Google Drive', 'https://drive.google.com/drive/search?q=%s', 'Other'),
]

/** `!W`, ` w ` → `w`. */
export function normalizeTrigger(raw: string): string {
  return raw.trim().replace(/^!+/, '').toLowerCase()
}

const TRIGGER_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.+-]*$/u

/** Why a bang can't be saved, or null when it can. `others` are the rest of
 *  the table, for the duplicate check. */
export function bangProblem(b: Pick<Bang, 'id' | 'trigger' | 'name' | 'url'>, others: readonly Bang[]): string | null {
  const trigger = normalizeTrigger(b.trigger)
  if (!trigger) return 'The trigger is empty'
  if (trigger.length > MAX_TRIGGER_LENGTH) return `The trigger is longer than ${MAX_TRIGGER_LENGTH} characters`
  if (!TRIGGER_RE.test(trigger)) return 'The trigger takes letters, digits and _ . + -'
  const clash = others.find((o) => o.id !== b.id && o.trigger === trigger)
  if (clash) return `!${trigger} is already ${clash.name}`
  if (!b.name.trim()) return 'The name is empty'
  const url = b.url.trim()
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return 'The URL must start with http:// or https://'
  if (url.length > MAX_URL_LENGTH) return 'The URL is too long'
  return null
}

/** A stored or pasted bang, cleaned up — or null when it isn't one. */
export function sanitizeBang(raw: unknown): Bang | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const bang: Bang = {
    id: str(r.id, 100),
    trigger: normalizeTrigger(str(r.trigger, MAX_TRIGGER_LENGTH + 4)),
    name: str(r.name, MAX_NAME_LENGTH),
    url: str(r.url, MAX_URL_LENGTH),
    category: str(r.category, MAX_CATEGORY_LENGTH) || 'Other',
    enabled: r.enabled !== false,
  }
  if (!bang.id) return null
  return bangProblem(bang, []) ? null : bang
}

/** Where a bang goes for `query`; its site's home page for no query. */
export function expandBang(bang: Pick<Bang, 'url'>, query: string): string {
  const q = query.trim()
  if (!q) return bangHome(bang)
  return bang.url.replace(PLACEHOLDERS, () => encodeURIComponent(q))
}

/** The site a bang belongs to — what `!w` alone opens. */
export function bangHome(bang: Pick<Bang, 'url'>): string {
  if (!HAS_PLACEHOLDER.test(bang.url)) return bang.url
  try {
    return new URL(bang.url.replace(PLACEHOLDERS, '')).origin + '/'
  } catch {
    return bang.url.replace(PLACEHOLDERS, '')
  }
}

export interface BangHit {
  bang: Bang
  /** The text without the bang. */
  query: string
  url: string
}

/** The first `!trigger` word in `text` that names a bang, with the rest of
 *  the text as its query: `!w vim` and `vim !w` both give Wikipedia / "vim".
 *  Null when no word does. */
export function findBang(text: string, lookup: (trigger: string) => Bang | undefined): BangHit | null {
  const words = text.trim().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word.length < 2 || word[0] !== '!') continue
    const bang = lookup(word.slice(1).toLowerCase())
    if (!bang) continue
    const query = words.filter((_, j) => j !== i).join(' ')
    return { bang, query, url: expandBang(bang, query) }
  }
  return null
}

/** The table as a lookup of its enabled bangs, by trigger. */
export function bangLookup(bangs: readonly Bang[]): Map<string, Bang> {
  const map = new Map<string, Bang>()
  for (const b of bangs) if (b.enabled && !map.has(b.trigger)) map.set(b.trigger, b)
  return map
}
