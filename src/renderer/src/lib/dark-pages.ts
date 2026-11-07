// Dark pages in the renderer: the config and Newbro's theme as main has them
// (src/main/dark-pages.ts), kept current for the address bar's moon, its
// popover and Settings → Dark pages, and the actions they take.

import { useSyncExternalStore } from 'react'
import {
  DEFAULT_DARK_PAGES,
  darkPageLook,
  normalizeDarkPages,
  siteKeyOf,
  siteRuleFor,
  type DarkPageLook,
  type DarkPagesConfig,
  type DarkPagesRule,
} from '../../../shared/dark-pages'

export interface DarkPagesState {
  config: DarkPagesConfig
  /** Newbro's own theme is dark right now — 'With Newbro's theme' follows it. */
  appDark: boolean
  ready: boolean
}

let state: DarkPagesState = { config: DEFAULT_DARK_PAGES, appDark: false, ready: false }
const listeners = new Set<() => void>()
let started = false

// Sliders being dragged: main's echoes of earlier values mustn't pull them
// back while the hand is still on them.
const LOCAL_EDIT_HOLD_MS = 400
let localEdit: { patch: Partial<DarkPagesConfig>; until: number } | null = null

function receive(raw: unknown): void {
  const r = (raw ?? {}) as { config?: unknown; appDark?: unknown }
  let config = normalizeDarkPages(r.config)
  if (localEdit && Date.now() < localEdit.until) config = normalizeDarkPages({ ...config, ...localEdit.patch })
  state = { config, appDark: r.appDark === true, ready: true }
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  api.onDarkPagesUpdated?.(receive)
  api.darkPagesGet?.().then(receive).catch(() => { /* older main: stays off */ })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useDarkPages(): DarkPagesState {
  return useSyncExternalStore(subscribe, () => state)
}

export function getDarkPagesState(): DarkPagesState {
  start()
  return state
}

/** What the page at `url` looks like, and the site rule behind it. */
export function pageLook(s: DarkPagesState, url: string): DarkPageLook & { site: string | null; ruleSite: string | null } {
  const look = darkPageLook(s.config, url, s.appDark)
  return { ...look, site: siteKeyOf(url), ruleSite: siteRuleFor(s.config, url)?.site ?? null }
}

// Comfort sliders move many times a second: show each at once (main applies
// it to the pages), but send at most one a frame.
let pendingPatch: Partial<DarkPagesConfig> | null = null
let flushQueued = false

function flushPatch(): void {
  flushQueued = false
  const patch = pendingPatch
  pendingPatch = null
  if (patch) void window.electronAPI.darkPagesSet?.(patch)
}

export const darkPagesActions = {
  set(patch: Partial<Omit<DarkPagesConfig, 'sites'>>): void {
    // Optimistic: the slider follows the hand, not the round trip.
    state = { ...state, config: normalizeDarkPages({ ...state.config, ...patch }) }
    const held = localEdit && Date.now() < localEdit.until ? localEdit.patch : {}
    localEdit = { patch: { ...held, ...patch }, until: Date.now() + LOCAL_EDIT_HOLD_MS }
    for (const listener of listeners) listener()
    pendingPatch = { ...(pendingPatch ?? {}), ...patch }
    if (!flushQueued) {
      flushQueued = true
      requestAnimationFrame(flushPatch)
    }
  },
  toggle(): void {
    void window.electronAPI.darkPagesToggle?.()
  },
  toggleSite(url: string): void {
    void window.electronAPI.darkPagesToggleSite?.(url)
  },
  /** Make the page at `url` dark or light, with the least rule that does. */
  setPage(url: string, dark: boolean): void {
    void window.electronAPI.darkPagesSetPage?.(url, dark)
  },
  setSite(site: string, rule: DarkPagesRule | null): void {
    void window.electronAPI.darkPagesSetSite?.(site, rule)
  },
  resetSites(): void {
    void window.electronAPI.darkPagesResetSites?.()
  },
}
