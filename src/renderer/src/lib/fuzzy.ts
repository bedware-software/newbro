/**
 * Subsequence-based fuzzy matcher with smart-case, in the spirit of fzf / VSCode's quick-open.
 *
 * Matching rules:
 *  - A query matches a candidate if every query character appears in the candidate
 *    in the same order (not necessarily adjacent). E.g. "yc" matches "Yandex.Code".
 *  - Smart case (like nvim's smartcase): if the query contains any uppercase letter
 *    the match is case-sensitive; otherwise it is case-insensitive.
 *
 * Scoring (higher is better, 0 means "no match"):
 *  - Exact substring matches beat subsequence matches.
 *  - Earlier matches beat later ones.
 *  - Word-start matches (start of string, after a separator, or at a camelCase boundary)
 *    get a bonus, so "yc" prefers "Yandex.Code" over "yyy...c".
 *  - Consecutive matching characters get a bonus, so "yand" prefers "Yandex" over "Y_a_n_d".
 */

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text.charCodeAt(i - 1)
  const cur = text.charCodeAt(i)
  const isAlphaNum = (c: number) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  // Any non-alphanumeric character is a separator, so the next char starts a new word.
  if (!isAlphaNum(prev)) return true
  // camelCase boundary: lowercase letter followed by uppercase letter.
  const prevIsLower = prev >= 97 && prev <= 122
  const curIsUpper = cur >= 65 && cur <= 90
  return prevIsLower && curIsUpper
}

/**
 * Score how well `query` matches `text`. Returns 0 if no match, otherwise a positive
 * score where higher means a better match.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  if (!text) return 0

  const hasUpper = /[A-Z]/.test(query)
  const q = hasUpper ? query : query.toLowerCase()
  // Keep the original text for word-boundary detection (camelCase needs original case),
  // but compare against a case-folded copy when smart-case is lowercase.
  const tCmp = hasUpper ? text : text.toLowerCase()
  const tOrig = text

  // Exact substring match — always preferred.
  const idx = tCmp.indexOf(q)
  if (idx !== -1) {
    let score = 1000 - Math.min(idx, 100) * 2
    if (idx === 0) score += 200
    else if (isWordStart(tOrig, idx)) score += 100
    // Shorter candidates score slightly higher so exact matches on short strings win.
    score += Math.max(0, 50 - text.length)
    return score
  }

  // Subsequence match: every char of q must appear in order in tCmp.
  let score = 0
  let qi = 0
  let lastMatchIdx = -2
  for (let ti = 0; ti < tCmp.length && qi < q.length; ti++) {
    if (tCmp.charCodeAt(ti) !== q.charCodeAt(qi)) continue
    let charScore = 1
    if (isWordStart(tOrig, ti)) charScore += 15
    if (ti === lastMatchIdx + 1) charScore += 8
    // Small penalty for big gaps between matches.
    if (lastMatchIdx >= 0) {
      const gap = ti - lastMatchIdx - 1
      if (gap > 0) charScore -= Math.min(gap, 4) * 0.2
    }
    score += charScore
    lastMatchIdx = ti
    qi++
  }
  if (qi !== q.length) return 0
  // Tie-breaker: prefer matches that reach the end of the query earlier in the text.
  score += Math.max(0, 20 - lastMatchIdx) * 0.1
  return score
}

export interface FuzzyField {
  value: string | undefined | null
  /** Multiplier applied to this field's score. Default 1. */
  weight?: number
}

/**
 * Score `query` against multiple candidate fields of one item. Returns the best
 * weighted field score, or 0 if none match.
 */
export function fuzzyScoreFields(query: string, fields: FuzzyField[]): number {
  let best = 0
  for (const f of fields) {
    if (!f.value) continue
    const s = fuzzyScore(query, f.value) * (f.weight ?? 1)
    if (s > best) best = s
  }
  return best
}

/**
 * Filter and sort `items` by how well they match `query`. Non-matches are dropped;
 * the result is ordered best-match-first. Empty queries pass items through unchanged.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getFields: (item: T) => FuzzyField[],
): T[] {
  if (!query.trim()) return items.slice()
  const scored: { item: T; score: number; originalIdx: number }[] = []
  for (let i = 0; i < items.length; i++) {
    const score = fuzzyScoreFields(query, getFields(items[i]))
    if (score > 0) scored.push({ item: items[i], score, originalIdx: i })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.originalIdx - b.originalIdx
  })
  return scored.map((s) => s.item)
}
