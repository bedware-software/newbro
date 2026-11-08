// Vimium-style hints for Vim mode's lists: in COMMAND each row wears a
// two-letter label — home-row letters first, and only letters the list's
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

/** Two-letter labels for `count` rows, the first letter changing slowest, so
 *  the top rows share it: ff fj fd fk… More rows than two letters can name
 *  get three letters each — all of them, as a two-letter label would be the
 *  start of three-letter ones and fire before they could be typed. As many
 *  as the alphabet allows. */
export function hintLabels(count: number, alphabet: string[]): string[] {
  const out: string[] = []
  if (count <= 0) return out
  const length = count > alphabet.length * alphabet.length ? 3 : 2
  const extend = (prefix: string): boolean => {
    if (prefix.length === length) {
      out.push(prefix)
      return out.length >= count
    }
    for (const letter of alphabet) if (extend(prefix + letter)) return true
    return false
  }
  extend('')
  return out
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

/** Labels for a popup's `count` rows and its COMMAND keymap with them;
 *  none while Vim mode is off (`keymap` null). INSERT has no use for them:
 *  its digits type, and the rows only show their numbers there. */
export function usePopupHints(keymap: VimKeymap | null, count: number): {
  labels: string[]
  keymap: VimKeymap | null
} {
  const alphabet = useMemo(() => hintAlphabet(keymap), [keymap])
  const labels = useMemo(() => (keymap ? hintLabels(count, alphabet) : []), [keymap, count, alphabet])
  const merged = useMemo(() => (keymap ? withHints(keymap, labels) : null), [keymap, labels])
  return { labels, keymap: merged }
}

// ── The main window's hint targets ──

export interface HintTarget {
  id: string
  activate: () => void
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
  snapshot = { targets: shown.sort((a, b) => a.order - b.order).flatMap((p) => p.targets), exclusive }
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
  const ids = targets ? targets.map((t) => t.id).join('\n') : null
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  useEffect(() => {
    const current = targetsRef.current
    if (!current || current.length === 0) return
    // Each one runs whatever its row does at the time it's picked.
    providers.set(name, {
      order,
      exclusive,
      targets: current.map((t) => ({ id: t.id, activate: () => targetsRef.current?.find((x) => x.id === t.id)?.activate() })),
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
  const labels = useMemo(() => (keymap ? hintLabels(targets.length, alphabet) : []), [keymap, targets, alphabet])
  const merged = useMemo(() => {
    if (!keymap) return null
    return exclusive ? hintsOnlyKeymap(keymap, labels) : withHints(keymap, labels)
  }, [keymap, labels, exclusive])
  useEffect(() => {
    const next = new Map<string, string>()
    labels.forEach((label, i) => { if (targets[i]) next.set(targets[i].id, label) })
    labelById = next
    labelListeners.forEach((l) => l())
  }, [labels, targets])
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
