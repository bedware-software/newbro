import { DEFAULT_VIM_KEYMAP, keysFor, parseVimKeymap, type VimKeymap } from './vim-keymap'

// The key UI advertises next to an app action (menu rows, the command
// palette, the sidebar's New Tab): in Vim mode the action's COMMAND-mode key —
// the regular shortcuts are off there — otherwise its first regular binding.

export interface HintSettings {
  vimMode?: boolean
  vimKeymap?: string | null
  keybindings?: Record<string, unknown>
}

export type ActionHint =
  | { kind: 'vim'; keys: string }
  | { kind: 'accelerator'; accelerator: string }
  | null

let parsed: { text: string; main: VimKeymap } | null = null

function vimCommandKeymap(text: string): VimKeymap {
  if (parsed?.text !== text) parsed = { text, main: parseVimKeymap(text).main }
  return parsed.main
}

/** Null when the action has no key to show. `fallbackAccelerator` stands in
 *  for an action the saved settings don't mention yet. */
export function actionHint(settings: HintSettings | null | undefined, action: string, fallbackAccelerator?: string): ActionHint {
  if (settings?.vimMode) {
    const keys = keysFor(vimCommandKeymap(settings.vimKeymap ?? DEFAULT_VIM_KEYMAP), action)[0]
    return keys ? { kind: 'vim', keys } : null
  }
  const bound = settings?.keybindings?.[action]
  if (bound === undefined) return fallbackAccelerator ? { kind: 'accelerator', accelerator: fallbackAccelerator } : null
  const first = typeof bound === 'string' ? bound : Array.isArray(bound) && typeof bound[0] === 'string' ? bound[0] : null
  return first ? { kind: 'accelerator', accelerator: first } : null
}
