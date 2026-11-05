// The search engines Settings and the Bangs page offer by name. Anything else
// is a custom URL template, `%s` standing for the query.

export const SEARCH_ENGINES: Record<string, string> = {
  Google: 'https://www.google.com/search?q=%s',
  Yandex: 'https://yandex.ru/search/?text=%s',
  DuckDuckGo: 'https://duckduckgo.com/?q=%s',
  Bing: 'https://www.bing.com/search?q=%s',
  Unduck: 'https://unduck.link?q=%s',
}

export const DEFAULT_SEARCH_ENGINE = SEARCH_ENGINES.Google

/** Why a custom engine template can't be used, or null when it can. */
export function searchEngineProblem(template: string): string | null {
  const t = template.trim()
  if (!/^https?:\/\/[^\s/]+/i.test(t)) return 'The address must start with http:// or https://'
  if (!t.includes('%s')) return 'Put %s where the query goes'
  return null
}
