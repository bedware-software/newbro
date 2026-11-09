// The header's buttons show their own keys — om the menu, oP Profile, oW
// Workspace, h / l back and forward, r reload, e the address, oD Dark
// pages… — while the keys' help is open (lib/help-panel.ts), and only then:
// the rest of the time they'd crowd the bar. Each is what the keymap binds
// the button's command to, as the user has it; a button with no key of its
// own shows nothing. (Letter labels picked on the fly are for lists whose
// rows come and go — the Sidebar's, search results — not for these.)

import { createContext, useContext } from 'react'
import { keysFor, displayKeySequence } from '../lib/vim-keymap'
import { useWindowVimKeymap } from '../lib/window-vim-keymap'
import { RowHint } from './KeyHints'

/** Toolbar → its buttons: whether the keys show (the help open) and the
 *  keys typed so far of one. */
export const HeaderHintsContext = createContext<{ on: boolean; pending: string }>({ on: false, pending: '' })

type HeaderHintsState = { on: boolean; pending: string }

/** The badge's place: on the button's top-left corner, inside the bar
 *  (the page's view covers anything below it). */
const CORNER = 'absolute -left-1.5 -top-1.5 bg-toolbar'

/** The security button's badge: its bottom-right corner, clear of the
 *  address's own at the bar's top-left. */
export const HEADER_HINT_BOTTOM_RIGHT = 'absolute -right-2 -bottom-2 bg-toolbar'

/** The badge of `command`'s key, for a `relative` box round its button;
 *  null while the help is closed, the button isn't shown (`shown` false)
 *  or the command has no key. `state`: the Toolbar's own buttons, rendered
 *  by the component that provides the context and so outside it. */
export function useHeaderHint(command: string, shown = true, className = CORNER, state?: HeaderHintsState): React.ReactNode {
  const fromContext = useContext(HeaderHintsContext)
  const { on, pending } = state ?? fromContext
  const keymap = useWindowVimKeymap()?.main ?? null
  if (!on || !shown || !keymap) return null
  const key = keysFor(keymap, command)[0]
  if (!key) return null
  const shownKey = displayKeySequence(key)
  return <RowHint mode="command" label={shownKey} pending={pending && key.startsWith(pending) ? pending : ''} className={className} />
}
