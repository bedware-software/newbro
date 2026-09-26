// Shared shapes for the address bar's suggestion popup — a separate
// transparent window (src/main/omnibox-popup.ts), since tab pages are native
// views that paint over the app's own DOM. The Toolbar sends the rows to
// show; the popup never takes the keyboard and only reports clicks back.

export type OmniboxRowKind = 'history' | 'navigate' | 'search' | 'search-history' | 'suggest'

export interface OmniboxPopupRow {
  kind: OmniboxRowKind
  /** Main text: the URL as shown, or the query. */
  contents: string
  /** Secondary text: the page title, or "Search Google". */
  description: string
  /** Page favicon URL for history rows. */
  favicon?: string
  /** Show the remove (X) button — a history URL or a past search. */
  removable: boolean
}

export interface OmniboxPopupSpec {
  /** The URL bar's box, in the parent window's content coordinates (CSS px).
   *  The popup opens right below it, as wide as it. */
  anchor: { x: number; y: number; width: number; height: number }
  rows: OmniboxPopupRow[]
  selected: number
  /** Lowercased words the user typed — bolded in the rows. */
  terms: string[]
  theme?: string
  themeVariant?: string
  density?: string
}

export type OmniboxPopupEvent =
  | {
      type: 'click'
      index: number
      /** 0 left, 1 middle. */
      button: number
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      altKey: boolean
    }
  | { type: 'remove'; index: number }
