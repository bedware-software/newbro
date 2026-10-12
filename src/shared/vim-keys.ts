// Key handling Vim mode shares between the window renderer (COMMAND mode,
// Search Everything) and tab pages (WEB mode, src/preload/webview-stealth.ts):
// turning a keydown into a key token and resolving token sequences against a
// keymap. Pure — no DOM beyond the KeyboardEvent fields it reads.

/** Joins the tokens of a key sequence into a keymap key. */
export const SEQUENCE_JOIN = '\u0000'

/** Key sequence (tokens joined by {@link SEQUENCE_JOIN}) → command. */
export type VimKeymap = Map<string, string>

/** A keymap as it crosses IPC: [sequence, command] pairs. */
export type VimKeymapEntries = Array<[string, string]>

const NAMED_EVENT_KEYS: Record<string, string> = {
  Enter: '<CR>', Escape: '<Esc>', ' ': '<Space>', Backspace: '<BS>', Delete: '<Del>',
  ArrowUp: '<Up>', ArrowDown: '<Down>', ArrowLeft: '<Left>', ArrowRight: '<Right>',
  Home: '<Home>', End: '<End>', PageUp: '<PageUp>', PageDown: '<PageDown>',
}

// US-layout characters by physical key, [plain, shifted], for keys typed in
// another input language (Russian: the j key gives "о").
const US_LAYOUT: Record<string, [string, string]> = {
  Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'],
  BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'],
  Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'],
  Digit1: ['1', '!'], Digit2: ['2', '@'], Digit3: ['3', '#'], Digit4: ['4', '$'], Digit5: ['5', '%'],
  Digit6: ['6', '^'], Digit7: ['7', '&'], Digit8: ['8', '*'], Digit9: ['9', '('], Digit0: ['0', ')'],
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>

/** The key token a keydown stands for, or null for a bare modifier, a dead
 *  key or a key with Ctrl/Alt/Cmd held (those are never Vim keys). */
export function keyTokenFromEvent(e: KeyEventLike): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return null
  if (e.key === 'Tab') return e.shiftKey ? '<S-Tab>' : '<Tab>'
  const named = NAMED_EVENT_KEYS[e.key]
  if (named) return named
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return `<${e.key}>`
  if (e.key.length !== 1) return null
  // Printable ASCII as typed; anything else by its physical key.
  if (e.key >= '!' && e.key <= '~') return e.key
  const letter = /^Key([A-Z])$/.exec(e.code)
  if (letter) return e.shiftKey ? letter[1] : letter[1].toLowerCase()
  const other = US_LAYOUT[e.code]
  if (other) return e.shiftKey ? other[1] : other[0]
  return e.key
}

export type KeymapMatch =
  | { kind: 'command'; command: string }
  | { kind: 'pending' }
  | { kind: 'none' }

/** Looks the pending tokens up: a full binding, the start of one, or nothing. */
export function matchKeys(map: VimKeymap, tokens: readonly string[]): KeymapMatch {
  const key = tokens.join(SEQUENCE_JOIN)
  const command = map.get(key)
  if (command) return { kind: 'command', command }
  const prefix = key + SEQUENCE_JOIN
  for (const seq of map.keys()) if (seq.startsWith(prefix)) return { kind: 'pending' }
  return { kind: 'none' }
}

// How long the next key of a sequence (gg, gt) may trail the previous one —
// vim's default timeoutlen.
export const SEQUENCE_TIMEOUT_MS = 1000

/**
 * Collects key tokens into sequences and resolves them against a keymap —
 * the framework-free core both sides drive. `feed` returns true when the key
 * belongs to Vim (a command ran or a sequence is pending), so the caller can
 * swallow it; `onPending` reports the unfinished sequence for a showcmd.
 */
export class KeySequencer {
  private tokens: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private keymap: () => VimKeymap,
    private onCommand: (command: string, e: KeyEventLike & { repeat: boolean }) => void,
    private onPending: (pending: string) => void = () => {},
  ) {}

  reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.tokens.length === 0) return
    this.tokens = []
    this.onPending('')
  }

  feed(e: KeyEventLike & { repeat: boolean }): boolean {
    const token = keyTokenFromEvent(e)
    if (!token) return false
    if (token === '<Esc>' && this.tokens.length > 0) {
      this.reset()
      return true
    }
    if (this.resolve([...this.tokens, token], e)) return true
    // Not a continuation: drop what was pending and try the key on its own.
    const hadPending = this.tokens.length > 0
    this.reset()
    return this.resolve([token], e) || hadPending
  }

  private resolve(tokens: string[], e: KeyEventLike & { repeat: boolean }): boolean {
    const match = matchKeys(this.keymap(), tokens)
    if (match.kind === 'command') {
      this.reset()
      this.onCommand(match.command, e)
      return true
    }
    if (match.kind === 'pending') {
      if (e.repeat) return true
      if (this.timer) clearTimeout(this.timer)
      this.tokens = tokens
      this.onPending(tokens.join(''))
      this.timer = setTimeout(() => this.reset(), SEQUENCE_TIMEOUT_MS)
      return true
    }
    return false
  }
}
