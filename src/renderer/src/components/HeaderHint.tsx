// The header's buttons wear labels in COMMAND, as the Sidebar's rows do
// (lib/hint-labels.ts): typing one presses its button — the menu, Profile,
// Workspace, back, reload, the address, Dark pages, the extensions… The
// header comes first in the labels' order, so its labels stay put as tabs
// come and go; every slot is registered whether its button shows or not
// (a hidden one does nothing and wears nothing), so they stay put as
// buttons come and go too.

import { createContext, useContext } from 'react'
import { useHintLabels, useHintTargets, type HintTarget } from '../lib/hint-labels'
import { RowHint } from './KeyHints'

/** Toolbar → its buttons: whether the labels are on (COMMAND, no popup
 *  over the window) and the keys typed so far of one. */
export const HeaderHintsContext = createContext<{ on: boolean; pending: string }>({ on: false, pending: '' })

/** The security button's badge: its bottom-right corner, clear of the
 *  address's own at the bar's top-left. */
export const HEADER_HINT_BOTTOM_RIGHT = 'absolute -right-2 -bottom-2 bg-toolbar'

/** The slots, left to right, before the group page (0), the Bookshelf (1)
 *  and the Sidebar (2). The extensions come last: how many there are
 *  varies. */
const HEADER_ORDER = {
  menu: -1.9,
  profile: -1.8,
  workspace: -1.7,
  downloads: -1.6,
  back: -1.5,
  forward: -1.4,
  reload: -1.3,
  store: -1.2,
  security: -1.1,
  url: -1.0,
  dark: -0.9,
  extensions: -0.8,
} as const

export type HeaderSlot = keyof typeof HEADER_ORDER

const NOTHING = (): void => {}

/** The badge's place: on the button's top-left corner, inside the bar
 *  (the page's view covers anything below it). */
const CORNER = 'absolute -left-1.5 -top-1.5 bg-toolbar'

type HeaderHintsState = { on: boolean; pending: string }

/** Registers `slot`'s button — `activate` presses it; null while it isn't
 *  shown — and returns its label badge, for a `relative` box round it.
 *  `state`: the Toolbar's own buttons, rendered by the component that
 *  provides the context and so outside it. */
export function useHeaderHint(slot: HeaderSlot, activate: (() => void) | null, className = CORNER, state?: HeaderHintsState): React.ReactNode {
  const fromContext = useContext(HeaderHintsContext)
  const { on, pending } = state ?? fromContext
  const id = `header:${slot}`
  useHintTargets(id, HEADER_ORDER[slot], on ? [{ id, activate: activate ?? NOTHING }] : null)
  const label = useHintLabels().get(id)
  return label && activate ? <RowHint mode="command" label={label} pending={pending} className={className} /> : null
}

/** The extensions' buttons, one slot for all of them: `buttons` in their
 *  order, each with its id and what pressing it does. Returns each one's
 *  badge by id. */
export function useHeaderHintList(buttons: Array<{ id: string; activate: () => void }>): (id: string, className?: string) => React.ReactNode {
  const { on, pending } = useContext(HeaderHintsContext)
  const targets: HintTarget[] = buttons.map((b) => ({ id: `header:ext:${b.id}`, activate: b.activate }))
  useHintTargets('header:extensions', HEADER_ORDER.extensions, on && targets.length > 0 ? targets : null)
  const labels = useHintLabels()
  return (id, className = CORNER) => {
    const label = labels.get(`header:ext:${id}`)
    return label ? <RowHint mode="command" label={label} pending={pending} className={className} /> : null
  }
}
