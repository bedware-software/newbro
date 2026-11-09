// Vimium-style hints for Vim mode's lists: in COMMAND each row wears a
// label of one, two or three letters, as few as the rows allow — home-row
// letters first, and only letters the list's
// keymap leaves free, so a label never shadows a command — and typing it
// picks the row. The labels go into the keymap as `hint-<n>` commands, so
// the usual sequencer runs them (the first letter shows as pending until the
// second comes, however long after; Esc drops it) — in a popup, in the
// window, and in a tab's page, which runs the window's COMMAND keys itself.
//
// In the main window several things can wear labels at once: each (the
// group page) registers its rows here with useHintTargets, App numbers them
// all in one go (useHintKeymap) and runs the picked one. One that registers
// as exclusive (the browser's own controls, ; — lib/chrome-hints.ts) wears
// the only labels while it's up, and takes every key: its labels may use
// any letter, and a key no label starts with puts the labels away.
//
// A label says what it names where it can: drawn from the row's name —
// "work" w, "fun" f, "Ubuntu" ub, "Тестовое собеседование" ts — from the
// letters the keymap leaves free, else the next free label in reach order.
// A row keeps the label it had while its name still gives it. And one thing
// wears one label: a tab listed both in the Sidebar and on its group's page
// registers under one id ("tab:<id>") from each, and the two rows show the
// same label.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'

// Letters by how easy they are to reach: the home row's, strongest fingers
// first, then the rows above and below.
const HINT_KEYS = [
  'f', 'j', 'd', 'k', 's', 'l', 'a', 'g', 'h',
  'e', 'i', 'r', 'u', 'w', 'o', 'c', 'm', 'v', 'n', 'x', 't', 'q', 'p', 'y', 'b', 'z',
]

const HINT_COMMAND = /^hint-(\d+)$/

/** What an exclusive provider's keymap runs for a key no label starts
 *  with: the labels go away. */
export const HINT_CANCEL_COMMAND = 'hint-cancel'

// Every key a keydown can stand for without Ctrl (shared/vim-keys.ts'
// keyTokenFromEvent): printable ASCII as typed, and the named keys.
const PLAIN_TOKENS: string[] = [
  ...Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)),
  '<CR>', '<Esc>', '<Space>', '<Tab>', '<S-Tab>', '<BS>', '<Del>',
  '<Up>', '<Down>', '<Left>', '<Right>', '<Home>', '<End>', '<PageUp>', '<PageDown>',
  ...Array.from({ length: 12 }, (_, i) => `<F${i + 1}>`),
]

/** The letters a label may use with `keymap`: those no binding starts with. */
export function hintAlphabet(keymap: VimKeymap | null): string[] {
  if (!keymap) return []
  const first = new Set<string>()
  for (const seq of keymap.keys()) first.add(seq.split(SEQUENCE_JOIN)[0])
  return HINT_KEYS.filter((k) => !first.has(k))
}

/** A row's name, for its label; none for rows with nothing to read. */
export type HintName = string | undefined

// Cyrillic as Latin letters, for a name's label: the badge reads Latin, and
// the keys go by position, so it's typed the same in either layout.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'e', ґ: 'g',
}
// Words that say nothing about a row.
const NOISE = new Set(['www', 'http', 'https', 'com', 'the'])

/** A name's words, lowercase Latin letters only. */
function nameWords(name: string): string[] {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  const latin = [...spaced].map((c) => TRANSLIT[c] ?? c).join('').normalize('NFD').replace(/\p{M}/gu, '')
  const words = latin.split(/[^a-z]+/).filter(Boolean)
  const kept = words.filter((w) => !NOISE.has(w))
  return kept.length > 0 ? kept : words
}

/** The labels of `length` a name suggests, the likeliest first: its words'
 *  initials, then its first word's letters in order ("ubuntu" → ub, un…),
 *  then the rest. Only letters in `allowed`. */
function nameCandidates(name: HintName, length: number, allowed: Set<string>): string[] {
  if (!name) return []
  // A bounded read of the name, and a bounded walk below: a long title (a
  // data: URL) mustn't cost more than a short one.
  const words = nameWords(name.slice(0, 120)).slice(0, 8)
    .map((w) => [...w].filter((c) => allowed.has(c)).slice(0, 16).join('')).filter(Boolean)
  if (words.length === 0) return []
  const out: string[] = []
  const add = (label: string): void => {
    if (label.length === length && !out.includes(label)) out.push(label)
  }
  const initials = words.map((w) => w[0])
  if (length === 1) {
    initials.forEach(add)
    for (const w of words) [...w].forEach(add)
    return out
  }
  // Every in-order pick of `length` letters from `letters`, starting at its first.
  let steps = 0
  const picks = (letters: string, from: string): void => {
    const walk = (prefix: string, at: number): void => {
      if (out.length > 120 || ++steps > 4000) return
      if (prefix.length === length) { add(prefix); return }
      for (let i = at; i < letters.length; i++) walk(prefix + letters[i], i + 1)
    }
    walk(from, 1)
  }
  add(initials.slice(0, length).join(''))
  for (let k = 0; k < words.length; k++) {
    const w = words[k]
    // The word on its own, then its first letter with the next words' initials.
    if (w.length >= length) picks(w, w[0])
    add(w[0] + initials.slice(k + 1, k + length).join(''))
    picks(w + words.slice(k + 1).join(''), w[0])
  }
  return out
}

/**
 * Labels for rows, all of one length — the shortest that names them all: a
 * letter each while the alphabet has enough, else two, else three. Never
 * mixed, as a shorter label would be the start of longer ones and fire
 * before they could be typed. As many as the alphabet allows.
 *
 * `rows` is how many there are, or each one's name: a named row gets a
 * label its name suggests (nameCandidates) when one is free — the top rows
 * choosing first — else one starting with its name's first letter, else the
 * next free one in reach order (ff fj fd…). `previous`: what each row wore
 * last; it keeps that while it's still one its name gives.
 */
export function hintLabels(rows: number | readonly HintName[], alphabet: string[], previous?: readonly (string | undefined)[]): string[] {
  const names: readonly HintName[] = typeof rows === 'number' ? Array.from({ length: Math.max(0, rows) }) : rows
  const n = alphabet.length
  if (names.length === 0 || n === 0) return []
  const count = Math.min(names.length, n ** 3)
  const length = count <= n ? 1 : count <= n * n ? 2 : 3
  const allowed = new Set(alphabet)
  const taken = new Set<string>()
  const out: Array<string | undefined> = Array.from({ length: count })
  const candidates = names.slice(0, count).map((name) => nameCandidates(name, length, allowed))

  // What each row wore, while its name still gives it.
  for (let i = 0; i < count; i++) {
    const before = previous?.[i]
    if (before && before.length === length && !taken.has(before) && candidates[i].includes(before)) {
      out[i] = before
      taken.add(before)
    }
  }
  // What its name suggests, top rows first.
  for (let i = 0; i < count; i++) {
    if (out[i]) continue
    const pick = candidates[i].find((c) => !taken.has(c))
    if (pick) {
      out[i] = pick
      taken.add(pick)
    }
  }
  // The rest in reach order — one starting with the name's letter first.
  const generic: string[] = []
  const extend = (prefix: string): void => {
    if (prefix.length === length) { generic.push(prefix); return }
    for (const letter of alphabet) extend(prefix + letter)
  }
  extend('')
  for (let i = 0; i < count; i++) {
    if (out[i]) continue
    const first = candidates[i][0]?.[0]
    const pick = (first ? generic.find((g) => g[0] === first && !taken.has(g)) : undefined) ?? generic.find((g) => !taken.has(g))
    if (!pick) break
    out[i] = pick
    taken.add(pick)
  }
  return out.filter((l): l is string => l !== undefined)
}

/** `keymap` with each label bound to `hint-<its index>`. */
export function withHints(keymap: VimKeymap, labels: string[]): VimKeymap {
  if (labels.length === 0) return keymap
  const map: VimKeymap = new Map(keymap)
  labels.forEach((label, i) => map.set([...label].join(SEQUENCE_JOIN), `hint-${i}`))
  return map
}

/** An exclusive provider's keymap: its labels, and every other key — each
 *  one `keymap` starts a binding with (its Ctrl chords too) and each plain
 *  key — bound to {@link HINT_CANCEL_COMMAND}, so nothing else runs, not
 *  even in the page, until a label is typed or the labels go. Ctrl chords
 *  nothing binds still reach whoever has the keys (Ctrl+C copies). */
export function hintsOnlyKeymap(keymap: VimKeymap, labels: string[]): VimKeymap {
  const map: VimKeymap = new Map()
  const starts = new Set(labels.map((label) => label[0]))
  const cancel = (token: string): void => {
    if (!starts.has(token)) map.set(token, HINT_CANCEL_COMMAND)
  }
  for (const seq of keymap.keys()) cancel(seq.split(SEQUENCE_JOIN)[0])
  for (const token of PLAIN_TOKENS) cancel(token)
  labels.forEach((label, i) => map.set([...label].join(SEQUENCE_JOIN), `hint-${i}`))
  return map
}

/** The row a `hint-<n>` command picks, or null for any other command. */
export function hintIndex(command: string): number | null {
  const m = HINT_COMMAND.exec(command)
  return m ? Number(m[1]) : null
}

/** Labels for a popup's rows — how many, or each one's name — and its
 *  COMMAND keymap with them; none while Vim mode is off (`keymap` null).
 *  INSERT has no use for them: typing goes in the box. */
export function usePopupHints(keymap: VimKeymap | null, rows: number | readonly HintName[]): {
  labels: string[]
  keymap: VimKeymap | null
} {
  const alphabet = useMemo(() => hintAlphabet(keymap), [keymap])
  const key = typeof rows === 'number' ? String(rows) : rows.map((r) => r ?? '').join('\u0000')
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const labels = useMemo(() => (keymap ? hintLabels(rowsRef.current, alphabet) : []), [keymap, key, alphabet])
  const merged = useMemo(() => (keymap ? withHints(keymap, labels) : null), [keymap, labels])
  return { labels, keymap: merged }
}

// ── The main window's hint targets ──

export interface HintTarget {
  /** One per thing: the same thing listed twice ("tab:<id>" in the Sidebar
   *  and on its group's page) registers the same id, and wears one label. */
  id: string
  activate: () => void
  /** What its row reads, for a label that says it. */
  name?: string
}

interface Provider {
  order: number
  exclusive: boolean
  targets: HintTarget[]
}

interface TargetSnapshot {
  targets: HintTarget[]
  /** An exclusive provider is up: its rows are the only ones listed. */
  exclusive: boolean
}

const providers = new Map<string, Provider>()
let snapshot: TargetSnapshot = { targets: [], exclusive: false }
const targetListeners = new Set<() => void>()
let labelById = new Map<string, string>()
const labelListeners = new Set<() => void>()

function rebuildTargets(): void {
  const all = [...providers.values()]
  const exclusive = all.some((p) => p.exclusive)
  const shown = exclusive ? all.filter((p) => p.exclusive) : all
  // A thing listed by two providers is one row to label: the first's.
  const seen = new Set<string>()
  const targets = shown.sort((a, b) => a.order - b.order).flatMap((p) => p.targets).filter((t) => {
    if (seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })
  snapshot = { targets, exclusive }
  targetListeners.forEach((l) => l())
}

/**
 * Registers `targets` (null: none) as `name`'s rows wanting labels, ahead of
 * providers with a higher `order`. Only a change of which rows (their ids)
 * renumbers; the rows' actions are kept current without one. An
 * `exclusive` provider's rows wear the only labels while it's registered,
 * and its keymap takes every key (hintsOnlyKeymap).
 */
export function useHintTargets(name: string, order: number, targets: HintTarget[] | null, exclusive = false): void {
  const ids = targets ? targets.map((t) => `${t.id}\t${t.name ?? ''}`).join('\n') : null
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  useEffect(() => {
    const current = targetsRef.current
    if (!current || current.length === 0) return
    // Each one runs whatever its row does at the time it's picked.
    providers.set(name, {
      order,
      exclusive,
      targets: current.map((t) => ({ id: t.id, name: t.name, activate: () => targetsRef.current?.find((x) => x.id === t.id)?.activate() })),
    })
    rebuildTargets()
    return () => {
      providers.delete(name)
      rebuildTargets()
    }
  }, [name, order, ids, exclusive])
}

function useTargetSnapshot(): TargetSnapshot {
  return useSyncExternalStore(
    (l) => {
      targetListeners.add(l)
      return () => { targetListeners.delete(l) }
    },
    () => snapshot,
  )
}

/** Every registered row, in label order (App). */
export function useHintTargetList(): HintTarget[] {
  return useTargetSnapshot().targets
}

/** App: the window's COMMAND keymap with a label on every registered row,
 *  and those labels published for the rows to wear. While an exclusive
 *  provider is up, its labels take any letter and the keymap is theirs
 *  alone (hintsOnlyKeymap). */
export function useHintKeymap(keymap: VimKeymap | null): { keymap: VimKeymap | null; targets: HintTarget[]; exclusive: boolean } {
  const { targets, exclusive } = useTargetSnapshot()
  const alphabet = useMemo(() => (exclusive ? HINT_KEYS : hintAlphabet(keymap)), [keymap, exclusive])
  // Each row keeps the label it wore while its name still gives it; the
  // browser's own controls (;) have no names and take labels in reach order.
  const previousRef = useRef(new Map<string, string>())
  const labels = useMemo(() => {
    if (!keymap) return []
    if (exclusive) return hintLabels(targets.length, alphabet)
    return hintLabels(targets.map((t) => t.name), alphabet, targets.map((t) => previousRef.current.get(t.id)))
  }, [keymap, targets, alphabet, exclusive])
  const merged = useMemo(() => {
    if (!keymap) return null
    return exclusive ? hintsOnlyKeymap(keymap, labels) : withHints(keymap, labels)
  }, [keymap, labels, exclusive])
  useEffect(() => {
    const next = new Map<string, string>()
    labels.forEach((label, i) => { if (targets[i]) next.set(targets[i].id, label) })
    labelById = next
    // Merged, not replaced: a row out of sight a while (COMMAND left, a
    // popup up) finds its label again.
    if (!exclusive) previousRef.current = new Map([...previousRef.current, ...next])
    labelListeners.forEach((l) => l())
  }, [labels, targets, exclusive])
  return { keymap: merged, targets, exclusive }
}

/** The labels the registered rows wear now, by their ids. */
export function useHintLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (l) => {
      labelListeners.add(l)
      return () => { labelListeners.delete(l) }
    },
    () => labelById,
  )
}
