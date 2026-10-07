// Extension keyboard shortcuts: the manifest's `commands`, as Chrome's
// chrome://extensions/shortcuts handles them. Each command starts on its
// `suggested_key` and the user can rebind or clear it in Settings →
// Extensions. Bindings are stored in Newbro's accelerator format (the one
// app keybindings use, e.g. "CmdOrCtrl+Shift+Y"); the shortcut
// interceptor in index.ts matches them after the app's own bindings, and
// chrome.commands.getAll reports them back in Chrome's format.

import Store from 'electron-store'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extensionLocalizer, listExtensions } from './manager'

export interface ExtensionCommand {
  name: string
  description: string
  /** Current binding (Newbro accelerator), '' when unbound. */
  shortcut: string
  /** The manifest's suggested key for this platform (Newbro accelerator). */
  suggested: string
}

export interface ExtensionCommands {
  extensionId: string
  commands: ExtensionCommand[]
}

/** Commands that activate the extension's toolbar action instead of
 *  firing chrome.commands.onCommand. */
export const ACTION_COMMANDS = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action'])

/** User choices: extensionId → command → accelerator ('' = cleared). */
const store = new Store<{ overrides: Record<string, Record<string, string>> }>({
  name: 'newbro-extension-commands',
  defaults: { overrides: {} },
})

const isMac = process.platform === 'darwin'
const platformKey = isMac ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'

// Chrome key names → Newbro's (see eventToKeyToken in SettingsDialog).
const CHROME_KEYS: Record<string, string> = {
  comma: ',',
  period: '.',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  delete: 'Delete',
  // Media keys: their DOM key names, which is what a keypress reports.
  mediaplaypause: 'MediaPlayPause',
  medianexttrack: 'MediaTrackNext',
  mediaprevtrack: 'MediaTrackPrevious',
  mediastop: 'MediaStop',
}

/** "Ctrl+Shift+Y" (Chrome) → "CmdOrCtrl+Shift+Y". Chrome's Ctrl means ⌘ on
 *  macOS and MacCtrl means Control; Newbro accelerators don't tell the two
 *  apart, so both land on CmdOrCtrl. */
export function chromeKeyToAccelerator(chromeKey: string): string {
  const mods: string[] = []
  let key = ''
  for (const raw of chromeKey.split('+').map((p) => p.trim()).filter(Boolean)) {
    const part = raw.toLowerCase()
    if (part === 'ctrl' || part === 'command' || part === 'macctrl') {
      if (!mods.includes('CmdOrCtrl')) mods.push('CmdOrCtrl')
    } else if (part === 'shift') mods.push('Shift')
    else if (part === 'alt') mods.push('Alt')
    else if (part === 'search') continue
    else key = CHROME_KEYS[part] ?? (raw.length === 1 ? raw.toUpperCase() : raw)
  }
  if (!key) return ''
  // Same modifier order eventToAccelerator records in.
  const order = ['CmdOrCtrl', 'Shift', 'Alt']
  return [...order.filter((m) => mods.includes(m)), key].join('+')
}

/** "CmdOrCtrl+Shift+Y" → Chrome's display form ("Ctrl+Shift+Y", or
 *  "Command+Shift+Y" on macOS), for chrome.commands.getAll. */
export function acceleratorToChromeKey(accel: string): string {
  if (!accel) return ''
  const parts = accel.split('+')
  const key = parts[parts.length - 1]
  // Chrome's modifier order: Ctrl (⌘), Alt, Shift.
  const mods = [
    parts.includes('CmdOrCtrl') ? (isMac ? 'Command' : 'Ctrl') : null,
    parts.includes('Alt') ? 'Alt' : null,
    parts.includes('Shift') ? 'Shift' : null,
  ].filter((m): m is string => m !== null)
  return [...mods, key].join('+')
}

function suggestedKeyFor(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return ''
  const s = (spec as { suggested_key?: unknown }).suggested_key
  if (typeof s === 'string') return chromeKeyToAccelerator(s)
  if (!s || typeof s !== 'object') return ''
  const keys = s as Record<string, unknown>
  const pick = keys[platformKey] ?? keys.default
  return typeof pick === 'string' ? chromeKeyToAccelerator(pick) : ''
}

/** Manifest commands per install path — manifests don't change while an
 *  extension stays installed at the same path. */
const manifestCache = new Map<string, Array<{ name: string; description: string; suggested: string }>>()

function manifestCommands(extDir: string): Array<{ name: string; description: string; suggested: string }> {
  const cached = manifestCache.get(extDir)
  if (cached) return cached
  let out: Array<{ name: string; description: string; suggested: string }> = []
  try {
    const manifestPath = join(extDir, 'manifest.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { commands?: Record<string, unknown> }
      const localize = extensionLocalizer(extDir)
      out = Object.entries(manifest.commands ?? {}).map(([name, spec]) => {
        const raw = (spec as { description?: unknown } | null)?.description
        const description =
          typeof raw === 'string' && raw ? localize(raw) : ACTION_COMMANDS.has(name) ? 'Activate the extension' : name
        return { name, description, suggested: suggestedKeyFor(spec) }
      })
    }
  } catch {
    out = []
  }
  manifestCache.set(extDir, out)
  return out
}

/** Every installed extension's commands with their current bindings. */
export function listExtensionCommands(): ExtensionCommands[] {
  const overrides = store.get('overrides')
  const out: ExtensionCommands[] = []
  for (const ext of listExtensions()) {
    const declared = manifestCommands(ext.path)
    if (declared.length === 0) continue
    const mine = overrides[ext.id] ?? {}
    out.push({
      extensionId: ext.id,
      commands: declared.map((c) => ({
        ...c,
        shortcut: c.name in mine ? mine[c.name] : c.suggested,
      })),
    })
  }
  return out
}

/** Bind a command (accelerator) or clear it (''). Passing the suggested
 *  key back records it like any other choice. */
export function setExtensionCommandShortcut(extensionId: string, command: string, accelerator: string): void {
  const overrides = { ...store.get('overrides') }
  overrides[extensionId] = { ...(overrides[extensionId] ?? {}), [command]: accelerator }
  store.set('overrides', overrides)
  bindingsCache = null
}

type Binding = { extensionId: string; command: string; accelerator: string }
/** The interceptor asks on every keypress; re-read at most every second
 *  (installs and enable/disable show up within that). */
let bindingsCache: { at: number; bindings: Binding[] } | null = null

/** Bindings of enabled extensions, for the shortcut interceptor. */
export function activeExtensionCommandBindings(): Binding[] {
  if (bindingsCache && Date.now() - bindingsCache.at < 1000) return bindingsCache.bindings
  const enabled = new Set(listExtensions().filter((e) => e.enabled).map((e) => e.id))
  const out: Binding[] = []
  for (const ext of listExtensionCommands()) {
    if (!enabled.has(ext.extensionId)) continue
    for (const c of ext.commands) {
      if (c.shortcut) out.push({ extensionId: ext.extensionId, command: c.name, accelerator: c.shortcut })
    }
  }
  bindingsCache = { at: Date.now(), bindings: out }
  return out
}

/** chrome.commands.getAll for one extension, in Chrome's shape. */
export function chromeCommandsFor(
  extensionId: string,
): Array<{ name: string; description: string; shortcut: string }> {
  const ext = listExtensionCommands().find((e) => e.extensionId === extensionId)
  return (ext?.commands ?? []).map((c) => ({
    name: c.name,
    description: c.description,
    shortcut: acceleratorToChromeKey(c.shortcut),
  }))
}
