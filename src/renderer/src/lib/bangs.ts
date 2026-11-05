// The renderer's copy of the bang table (main's src/main/bangs-store.ts) and
// the Settings switch, for resolving `!w vim` as it's typed. App loads both
// at startup and follows their broadcasts.

import { bangLookup, findBang, normalizeTrigger, type Bang, type BangHit } from '../../../shared/bangs'

let lookup = new Map<string, Bang>()
let enabled = true

export function setBangs(list: readonly Bang[] | null | undefined): void {
  lookup = bangLookup(list ?? [])
}

export function setBangsEnabled(on: boolean): void {
  enabled = on
}

export function bangsEnabled(): boolean {
  return enabled
}

/** The bang `text` fires, if bangs are on and a `!word` in it names one. */
export function resolveBang(text: string): BangHit | null {
  if (!enabled) return null
  return findBang(text, (t) => lookup.get(t))
}

/** `text` with its `!word` moved to the front and `query` after it: how a
 *  suggestion for the bare query reads with the bang still on it. */
export function withBang(hit: BangHit, query: string): string {
  return `!${hit.bang.trigger} ${query}`
}

/** Bangs the word being typed at the end could become: `!w` → `!wa`, `!wt`
 *  … Not the one it already names. */
export function bangCompletions(text: string, max: number): Array<{ bang: Bang; text: string; query: string }> {
  if (!enabled || /\s$/.test(text)) return []
  const words = text.trim().split(/\s+/)
  const last = words[words.length - 1] ?? ''
  if (last[0] !== '!') return []
  const prefix = normalizeTrigger(last)
  const rest = words.slice(0, -1)
  const query = rest.join(' ')
  const out: Array<{ bang: Bang; text: string; query: string }> = []
  const candidates = [...lookup.values()]
    .filter((b) => b.trigger.startsWith(prefix) && b.trigger !== prefix)
    .sort((a, b) => a.trigger.length - b.trigger.length || a.trigger.localeCompare(b.trigger))
  for (const bang of candidates.slice(0, max)) {
    out.push({ bang, query, text: [...rest, `!${bang.trigger}`].join(' ') + ' ' })
  }
  return out
}
