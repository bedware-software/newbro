// Which-key: while a prefix is pending in COMMAND (o, d, n, t, g…), what
// can follow it, each with what it does — "o → Workspace w · Tab t · …".
// Built from the live keymap, the user's own keys included. The Sidebar
// shows it at its foot, in its key hint bar (KeyHints' SidebarHintBar);
// with the Sidebar hidden, components/WhichKey.tsx shows it in a strip
// along the bottom of the page area, styled as the Downloads page's hint
// bar. Either goes on the next key, Esc or the sequence's timeout — when
// the pending keys do. Typed in a page counts too: the page reports its
// pending keys (lib/vim-mode.ts).

import { useEffect, useMemo, useRef, useState } from 'react'
import { SEQUENCE_JOIN, type VimKeymap } from '../../../shared/vim-keys'
import { HINT_CANCEL_COMMAND, hintIndex } from './hint-labels'
import { displayKeySequence, vimCommandLabel } from './vim-keymap'
import { useChromeHintsActive } from './chrome-hints'

export interface WhichKeyEntry {
  /** What to type next, as caps read (the rest of the sequence). */
  keys: string
  label: string
}

// Short names for what follows a verb — the prefix already says new, close,
// open or toggle. Any other command (one the user bound under a prefix of
// their own) goes by its full name.
const SHORT_LABELS: Record<string, string> = {
  'new-tab': 'Tab',
  'new-group': 'Group',
  'new-workspace': 'Workspace',
  'new-profile': 'Profile',
  'close-tab': 'Tab',
  'close-group': 'Group',
  'delete-workspace': 'Workspace',
  'pick-tab': 'Tab',
  'pick-workspace': 'Workspace',
  'pick-group': 'Group',
  'pick-profile': 'Profile',
  'open-downloads': 'Downloads',
  'open-bangs': 'Bangs',
  'app-menu': 'Menu',
  'extensions-menu': 'Extensions',
  'site-info': 'Site info',
  'dark-pages-menu': 'Dark pages',
  'profile-menu': 'Profile menu',
  'workspace-menu': 'Workspace menu',
  'toggle-sidebar': 'Sidebar',
  'toggle-bookshelf': 'Bookshelf',
  'page-top': 'Top',
  'focus-input': 'Text field',
  'set-comment': 'Comment',
}

// Shown only once the prefix has been held this long, so a quick dd or gg
// doesn't flash it.
const SHOW_DELAY_MS = 150

/** What can follow `pending` (keys typed so far, joined) in `keymap`: one
 *  entry per next key, in the keymap's order. A next key that only starts
 *  more sequences says how many. */
export function whichKeyEntries(keymap: VimKeymap, pending: string): WhichKeyEntry[] {
  if (!pending) return []
  const groups = new Map<string, Array<{ rest: string[]; command: string }>>()
  for (const [seq, command] of keymap) {
    if (hintIndex(command) !== null || command === HINT_CANCEL_COMMAND) continue
    const tokens = seq.split(SEQUENCE_JOIN)
    let typed = ''
    for (let k = 0; k < tokens.length - 1; k++) {
      typed += tokens[k]
      if (typed.length > pending.length) break
      if (typed !== pending) continue
      const rest = tokens.slice(k + 1)
      const list = groups.get(rest[0])
      if (list) list.push({ rest, command })
      else groups.set(rest[0], [{ rest, command }])
      break
    }
  }
  const entries: WhichKeyEntry[] = []
  for (const [next, list] of groups) {
    if (list.length === 1) {
      const { rest, command } = list[0]
      entries.push({ keys: displayKeySequence(rest.join('')), label: SHORT_LABELS[command] ?? vimCommandLabel(command) })
    } else {
      entries.push({ keys: `${displayKeySequence(next)}…`, label: `${list.length} more` })
    }
  }
  return entries
}

/** The entries to show for `pending` now: none until it's been pending a
 *  moment (then at once as it grows, gc after g), none while ;'s labels are
 *  up — their letters are pending then — and none with no keymap. */
export function useWhichKey(keymap: VimKeymap | null, pending: string): WhichKeyEntry[] {
  const hintsUp = useChromeHintsActive()
  const [shownFor, setShownFor] = useState('')
  const shownRef = useRef('')
  useEffect(() => {
    const show = (keys: string): void => {
      shownRef.current = keys
      setShownFor(keys)
    }
    if (!pending) {
      show('')
      return
    }
    // Already showing: the next level follows straight away.
    if (shownRef.current) {
      show(pending)
      return
    }
    const timer = setTimeout(() => show(pending), SHOW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [pending])
  return useMemo(
    () => (keymap && !hintsUp && shownFor && shownFor === pending ? whichKeyEntries(keymap, shownFor) : []),
    [keymap, hintsUp, shownFor, pending],
  )
}

