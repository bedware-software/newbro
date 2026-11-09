// The keys' help (components/KeysPage.tsx, vimperium://keys), in the sections the default
// keymap is written in (shared/vim-default-keymap.ts: its `" ── title ──`
// lines), each under a heading people read: Page, Sidebar, Open (o)…

import { DEFAULT_VIM_KEYMAP } from '../../../shared/vim-default-keymap'
import type { VimContext } from '../../../shared/vim-default-keymap'

export type HelpContext = VimContext | 'settings'

export interface HelpSection {
  id: string
  title: string
  /** Which of the keymap's maps its keys are in. */
  context: HelpContext
  /** Its commands, in the keymap's order. */
  commands: string[]
}

/** The keymap's own section titles, as headings. */
const TITLES: Array<[RegExp, string, HelpContext]> = [
  [/^COMMAND: the page/, 'Page', 'command'],
  [/^COMMAND: the Sidebar/, 'Sidebar', 'command'],
  [/^COMMAND: split view/, 'Split view', 'command'],
  [/^COMMAND: n, new/, 'New (n)', 'command'],
  [/^COMMAND: d, delete/, 'Delete (d)', 'command'],
  [/^COMMAND: o, open/, 'Open (o)', 'command'],
  [/^COMMAND: t, toggle/, 'Toggle (t)', 'command'],
  [/^COMMAND: app commands/, 'Browser', 'command'],
  [/^The Command Palette/, 'Command Palette & pickers', 'search'],
  [/^Address editor/, 'Address editor', 'url'],
  [/^Find in page/, 'Find in page', 'find'],
]

/** Keys a popup's map takes from the page's (lib/vim-keymap.ts), with no
 *  line of their own in its section: moving through the results, Enter,
 *  typing again. */
const INHERITED: Partial<Record<HelpContext, string[]>> = {
  search: ['cursor-down', 'cursor-up', 'cursor-first', 'cursor-last', 'row-open', 'insert-mode'],
  find: ['insert-mode'],
}

let cached: HelpSection[] | null = null

/** The sections, in the keymap's order. */
export function helpSections(): HelpSection[] {
  if (cached) return cached
  const out: HelpSection[] = []
  let current: HelpSection | null = null
  for (const raw of DEFAULT_VIM_KEYMAP.split('\n')) {
    const line = raw.trim()
    const header = /^"\s*──\s*(.+?)\s*─+\s*$/.exec(line)
    if (header) {
      const known = TITLES.find(([re]) => re.test(header[1]))
      const context: HelpContext = known ? known[2] : 'command'
      current = {
        id: `section-${out.length}`,
        title: known ? known[1] : header[1],
        context,
        commands: [...(INHERITED[context] ?? [])],
      }
      out.push(current)
      continue
    }
    if (!current || !line || line.startsWith('"')) continue
    current.commands.push(line.split(/\s+/)[0])
  }
  cached = out
  return out
}
