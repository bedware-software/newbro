import { DEFAULT_VIM_KEYMAP, displayKeySequence, keysFor, parseVimKeymap, type VimKeymap } from './vim-keymap'

// The key UI advertises next to an app action (menu rows, the command
// palette, the sidebar's New Tab): the action's COMMAND-mode key. Vim is
// the only mode, so the regular shortcuts in the settings are never live.

export interface HintSettings {
  /** Always on — Vim is the only mode; not read. */
  vimMode?: boolean
  vimKeymap?: string | null
  keybindings?: Record<string, unknown>
}

export type ActionHint =
  | { kind: 'vim'; keys: string }
  // Never made any more (a regular shortcut, from before Vim was the only
  // mode); still in the type for the callers that check for it.
  | { kind: 'accelerator'; accelerator: string }
  | null

let parsed: { text: string; main: VimKeymap } | null = null

function vimCommandKeymap(text: string): VimKeymap {
  if (parsed?.text !== text) parsed = { text, main: parseVimKeymap(text).main }
  return parsed.main
}

/** Null when the action has no key to show. Before the settings are in, the
 *  default keymap's key. `_fallbackAccelerator` is a regular shortcut some
 *  callers still pass — never shown, as none is live. */
export function actionHint(settings: HintSettings | null | undefined, action: string, _fallbackAccelerator?: string): ActionHint {
  const keys = keysFor(vimCommandKeymap(settings?.vimKeymap ?? DEFAULT_VIM_KEYMAP), action)[0]
  return keys ? { kind: 'vim', keys: displayKeySequence(keys) } : null
}
