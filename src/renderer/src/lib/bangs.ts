// The renderer's copy of the bang table (main's src/main/bangs-store.ts) and
// the Settings switch, for resolving `!w vim` as it's typed. App loads both
// at startup and follows their broadcasts.

import { bangLabelLookup, bangLookup, expandBang, findBangs, normalizeTrigger, type Bang, type BangHit, type MultiBangHit } from '../../../shared/bangs'

let lookup = new Map<string, Bang>()
let labels = new Map<string, Bang[]>()
let enabled = true

export function setBangs(list: readonly Bang[] | null | undefined): void {
  lookup = bangLookup(list ?? [])
  labels = bangLabelLookup(list ?? [])
}

export function setBangsEnabled(on: boolean): void {
  enabled = on
}

export function bangsEnabled(): boolean {
  return enabled
}

/** Every bang `text` fires — by trigger, or a label's — if bangs are on. */
export function resolveBangs(text: string): MultiBangHit | null {
  if (!enabled) return null
  return findBangs(text, (t) => lookup.get(t), (l) => labels.get(l))
}

/** The bang `text` fires, if bangs are on and a `!word` in it names one —
 *  the first, when it names several (resolveBangs has them all). */
export function resolveBang(text: string): (BangHit & { words: string[] }) | null {
  const hit = resolveBangs(text)
  if (!hit) return null
  const bang = hit.bangs[0]
  return { bang, query: hit.query, url: expandBang(bang, hit.query), words: hit.words }
}

/** A suggestion for the bare query with the `!words` still on it, moved to
 *  the front: "vim editor" → "!w vim editor", "!avito !ozon steam deck". */
export function withBang(hit: { words: string[] }, query: string): string {
  return `${hit.words.join(' ')} ${query}`
}

/** What the word being typed at the end could become: the bangs `!w` →
 *  `!wa`, `!wt` … and the labels it starts. Not the one it already names. */
export function bangCompletions(text: string, max: number): Array<{ text: string; query: string; bang?: Bang; label?: { name: string; bangs: Bang[] } }> {
  if (!enabled || /\s$/.test(text)) return []
  const words = text.trim().split(/\s+/)
  const last = words[words.length - 1] ?? ''
  if (last[0] !== '!') return []
  const prefix = normalizeTrigger(last)
  const rest = words.slice(0, -1)
  // The query without any bang words already typed before this one.
  const query = rest.filter((w) => !(w.length >= 2 && w[0] === '!' && (lookup.has(w.slice(1).toLowerCase()) || labels.has(w.slice(1).toLowerCase())))).join(' ')
  const out: Array<{ text: string; query: string; bang?: Bang; label?: { name: string; bangs: Bang[] } }> = []
  const complete = (word: string): string => [...rest, `!${word}`].join(' ') + ' '
  const labelNames = [...labels.keys()]
    .filter((l) => l.startsWith(prefix) && l !== prefix && !lookup.has(l))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  for (const name of labelNames.slice(0, max)) out.push({ label: { name, bangs: labels.get(name)! }, query, text: complete(name) })
  const candidates = [...lookup.values()]
    .filter((b) => b.trigger.startsWith(prefix) && b.trigger !== prefix)
    .sort((a, b) => a.trigger.length - b.trigger.length || a.trigger.localeCompare(b.trigger))
  for (const bang of candidates.slice(0, Math.max(0, max - out.length))) out.push({ bang, query, text: complete(bang.trigger) })
  return out
}
