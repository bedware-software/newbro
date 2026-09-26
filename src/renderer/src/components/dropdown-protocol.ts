// Shared types for the dropdown popup (separate BrowserWindow). Both the
// parent renderer (which calls openDropdown) and the popup renderer (which
// renders the menu) import from this module so the spec/event shapes stay in
// sync and IPC payloads don't drift.

export type IconName =
  | 'User'
  | 'Layout'
  | 'Search'
  | 'Settings'
  | 'Download'
  | 'Info'
  | 'LogOut'
  | 'Plus'
  | 'Pencil'
  | 'Trash2'
  | 'Menu'
  | 'Globe'
  | 'Import'
  | 'Upload'
  | 'X'
  | 'FolderPlus'
  | 'FolderMinus'
  | 'FolderInput'
  | 'Folder'
  | 'CopyPlus'
  | 'MessageSquare'
  | 'MessageSquareOff'
  | 'FilePlus'
  | 'Pin'
  | 'PinOff'
  | 'EyeOff'
  | 'Puzzle'
  | 'PanelLeft'
  | 'PanelLeftClose'
  | 'FolderOpen'
  | 'Link'
  | 'Pause'
  | 'Play'
  | 'RotateCw'
  | 'ListX'

export interface DropdownItem {
  id: string
  name: string
}

/** One circle in the swatch strip (see DropdownSpec.colors). */
export interface DropdownColor {
  /** CSS colour — painted as the circle's fill and echoed back on pick. */
  value: string
  /** Human name ('Teal'), used for the tooltip / aria-label. */
  label: string
}

export interface DropdownAction {
  id: string
  label: string
  iconName: IconName
  // Display-only — rendered on the right. Each segment becomes its own kbd
  // chip (e.g. ['⌘', ',']). Use an array, not a single string, so the popup
  // can style multi-key shortcuts consistently with the rest of the app.
  shortcut?: string[]
  destructive?: boolean
  // 'before' inserts a horizontal rule above this action.
  divider?: 'before'
  // When true the row is rendered muted and clicks are ignored. Use for
  // affordances that exist but aren't currently available (e.g. updates in
  // a dev build).
  disabled?: boolean
  disabledTitle?: string
}

// Anchor rectangle in the *parent window's content-area* coordinates (CSS
// pixels). Main process translates to screen coords using the parent's
// content bounds. Only the trigger button knows its own client rect, so we
// pass it through.
export interface DropdownAnchor {
  x: number
  y: number
  width: number
  height: number
}

export interface DropdownSpec {
  // Opaque opener id. The renderer assigns one per Dropdown/AppMenu instance
  // and main echoes it back on every event so multiple dropdowns can share
  // the global event channel without one's listener firing for another's
  // events. It also lets main 'cancel' a previously-open dropdown when a
  // different one is opened.
  openerId: string
  // 'list' = selectable items (workspace/profile pickers).
  // 'menu' = action-only menu (AppMenu / sidebar context menus).
  kind: 'list' | 'menu'
  // Provide one of these. `anchor` opens the popup BELOW a trigger button;
  // `position` opens AT a point (used for cursor-driven context menus).
  // Both are CSS pixels in the parent window's content-area coords.
  anchor?: DropdownAnchor
  position?: { x: number; y: number }
  // Mirrored from the parent's <html> data attributes so the popup picks up
  // the user's theme. Falls back to defaults if absent.
  theme?: string
  themeVariant?: string

  // Optional non-interactive caption shown at the top of the menu — useful
  // for context menus to clarify what the actions apply to (e.g. the tab's
  // title, the group's name).
  header?: string

  // Optional strip of colour circles rendered above the actions (Edge-style
  // group recolouring). Picking one emits a 'color' event and closes the
  // menu; `selectedColor` marks the current one with a ring + check.
  colors?: DropdownColor[]
  selectedColor?: string | null

  // List kind:
  iconName?: IconName
  selectedId?: string | null
  items?: DropdownItem[]
  reorder?: boolean
  editable?: boolean
  deletable?: boolean
  canDelete?: boolean
  newAction?: { label: string }

  // Both kinds (list = bottom actions; menu = the entire body):
  actions?: DropdownAction[]

  // Menu kind: opened from the keyboard (a panel's vim mode, or m on the
  // Downloads page). The first action starts highlighted; j/k (or the arrow
  // keys) move through the actions, h/l across the colour swatches, Enter
  // picks the highlighted one.
  keyboard?: boolean
}

export type DropdownEventBody =
  | { type: 'select'; id: string }
  | { type: 'edit'; id: string; name: string }
  | { type: 'delete'; id: string; name: string }
  | { type: 'reorder'; sourceId: string; sourceIndex: number; targetIndex: number }
  | { type: 'new' }
  | { type: 'action'; actionId: string }
  | { type: 'color'; color: string }
  | { type: 'cancel' }

// Events that travel back to the parent renderer carry the originating
// openerId so the corresponding component can filter for its own events.
export type DropdownEvent = DropdownEventBody & { openerId: string }

// Events that close the popup automatically once dispatched. Reorder keeps
// the popup open so the user can drag multiple items in one session.
export function isTerminalEvent(evt: DropdownEventBody): boolean {
  return evt.type !== 'reorder'
}

// One-shot opener for context menus and any other "open, await selection,
// dispatch, close" use case. Generates a fresh openerId, subscribes to the
// dropdown event channel, resolves with the user's choice (or null if they
// dismissed the menu via blur / Esc / cancel). Reorder is not supported here
// because the wrapper auto-resolves on the first event — use the long-lived
// listener pattern (see Toolbar.Dropdown) when you need streaming events.
export function openDropdownAsync(
  spec: Omit<DropdownSpec, 'openerId'>,
): Promise<DropdownEvent | null> {
  const openerId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
  return new Promise((resolve) => {
    const api = window.electronAPI
    if (!api?.onDropdownEvent || !api?.openDropdown) {
      resolve(null)
      return
    }
    const cleanup = api.onDropdownEvent((evt: unknown) => {
      const e = evt as DropdownEvent
      if (e.openerId !== openerId) return
      cleanup()
      if (e.type === 'cancel') resolve(null)
      else resolve(e)
    })
    api.openDropdown({ ...spec, openerId })
  })
}
