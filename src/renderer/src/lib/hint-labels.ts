// Vimium-style hints for Vim mode's lists: in COMMAND each row wears a
// two-letter label — home-row letters first, and only letters the list's
// keymap leaves free, so a label never shadows a command — and typing it
// picks the row. The labels go into the keymap as `hint-<n>` commands, so
// the usual sequencer runs them (the first letter shows as pending, Esc
// drops it, a pause forgets it) — in a popup, in the window, and in a tab's
// page, which runs the window's COMMAND keys itself.
//
// In the main window several things can wear labels at once (the group
// page, a pinned Sidebar): each registers its rows here with useHintTargets,
// App numbers them all in one go (useHintKeymap) and runs the picked one.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'

// Letters by how easy they are to reach: the home row's, strongest fingers
// first, then the rows above and below.
const HINT_KEYS = [
  'f', 'j', 'd', 'k', 's', 'l', 'a', 'g', 'h',
  'e', 'i', 'r', 'u', 'w', 'o', 'c', 'm', 'v', 'n', 'x', 't', 'q', 'p', 'y', 'b', 'z',
]

const HINT_COMMAND = /^hint-(\d+)$/

/** The letters a label may use with `keymap`: those no binding starts with. */
export function hintAlphabet(keymap: VimKeymap | null): string[] {
  if (!keymap) return []
  const first = new Set<string>()
  for (const seq of keymap.keys()) first.add(seq.split(SEQUENCE_JOIN)[0])
  return HINT_KEYS.filter((k) => !first.has(k))
}

/** Two-letter labels for `count` rows, the first letter changing slowest, so
 *  the top rows share it: ff fj fd fk… As many as the alphabet allows. */
export function hintLabels(count: number, alphabet: string[]): string[] {
  const out: string[] = []
  for (const a of alphabet) {
    for (const b of alphabet) {
      if (out.length >= count) return out
      out.push(a + b)
    }
  }
  return out
}

/** `keymap` with each label bound to `hint-<its index>`. */
export function withHints(keymap: VimKeymap, labels: string[]): VimKeymap {
  if (labels.length === 0) return keymap
  const map: VimKeymap = new Map(keymap)
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
  targets: HintTarget[]
}

const providers = new Map<string, Provider>()
let targetList: HintTarget[] = []
const targetListeners = new Set<() => void>()
let labelById = new Map<string, string>()
const labelListeners = new Set<() => void>()

function rebuildTargets(): void {
  targetList = [...providers.values()].sort((a, b) => a.order - b.order).flatMap((p) => p.targets)
  targetListeners.forEach((l) => l())
}

/**
 * Registers `targets` (null: none) as `name`'s rows wanting labels, ahead of
 * providers with a higher `order`. Only a change of which rows (their ids)
 * renumbers; the rows' actions are kept current without one.
 */
export function useHintTargets(name: string, order: number, targets: HintTarget[] | null): void {
  const ids = targets ? targets.map((t) => t.id).join('\n') : null
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  useEffect(() => {
    const current = targetsRef.current
    if (!current || current.length === 0) return
    // Each one runs whatever its row does at the time it's picked.
    providers.set(name, {
      order,
      targets: current.map((t) => ({ id: t.id, activate: () => targetsRef.current?.find((x) => x.id === t.id)?.activate() })),
    })
    rebuildTargets()
    return () => {
      providers.delete(name)
      rebuildTargets()
    }
  }, [name, order, ids])
}

/** Every registered row, in label order (App). */
export function useHintTargetList(): HintTarget[] {
  return useSyncExternalStore(
    (l) => {
      targetListeners.add(l)
      return () => { targetListeners.delete(l) }
    },
    () => targetList,
  )
}

/** App: the window's COMMAND keymap with a label on every registered row,
 *  and those labels published for the rows to wear. */
export function useHintKeymap(keymap: VimKeymap | null): { keymap: VimKeymap | null; targets: HintTarget[] } {
  const targets = useHintTargetList()
  const alphabet = useMemo(() => hintAlphabet(keymap), [keymap])
  const labels = useMemo(() => (keymap ? hintLabels(targets.length, alphabet) : []), [keymap, targets, alphabet])
  const merged = useMemo(() => (keymap ? withHints(keymap, labels) : null), [keymap, labels])
  useEffect(() => {
    const next = new Map<string, string>()
    labels.forEach((label, i) => { if (targets[i]) next.set(targets[i].id, label) })
    labelById = next
    labelListeners.forEach((l) => l())
  }, [labels, targets])
  return { keymap: merged, targets }
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
