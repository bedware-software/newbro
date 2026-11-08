// Dark pages — Vimperium's own dark mode for web pages, in place of a dark-mode
// extension. Which pages are dark, and how, is decided in
// src/shared/dark-pages.ts; this module makes it so.
//
// It works through Chromium itself, over each page's DevTools protocol
// session (main/tab-debugger.ts), so nothing is parsed or rewritten in the
// page and nothing waits on page scripts:
//   * Emulation.setEmulatedMedia(prefers-color-scheme: dark) — a site that
//     has its own dark theme shows it, as with the OS in dark mode.
//   * Emulation.setAutoDarkModeOverride — Chromium's Auto Dark Mode for Web
//     Contents (chrome://flags/#enable-force-dark): what the page paints light
//     is darkened as it's painted, photos left alone. Chromium skips a page
//     whose root declares a dark color-scheme, so a site's own dark theme
//     isn't darkened twice.
// Both outlive navigations — a cross-site one swaps the renderer, and the
// session carries them over before the new page commits — so a page's first
// frame is already dark: no white flash. They take effect only once the page
// has a renderer, though, and a new tab gets its first with its first
// navigation, after the request for the page has gone out: a tab's first
// load waits for its look on about:blank (readyDarkFirstLoad).
// Out-of-process iframes (a cross-site embed) are their own targets: the
// session attaches to each as it appears and gives it the page's look.
//
// The comfort sliders (brightness, contrast, warmth) are a CSS filter on the
// page's root that the tab preload (src/preload/webview-stealth.ts) asks for
// as the document starts, before it paints.

import { app, BrowserWindow, ipcMain, nativeTheme, type WebContents } from 'electron'
import Store from 'electron-store'
import { log } from './log'
import { loadSettings } from './settings-store'
import { notifyCloudChange } from './cloud-sync'
import { holdDebugger, holdsDebugger, onDebuggerReleased, releaseDebugger } from './tab-debugger'
import {
  DEFAULT_DARK_PAGES,
  SESSION_MARKER,
  darkPageCss,
  darkPageLook,
  darkPagesGloballyOn,
  darkPagesInUse,
  normalizeDarkPages,
  normalizeSiteKey,
  siteKeyOf,
  siteRuleGiving,
  toggledSiteRule,
  type DarkPageLook,
  type DarkPagesConfig,
  type DarkPagesRule,
} from '../shared/dark-pages'

/** What a dark page's own canvas shows where the page paints nothing — the
 *  shade Chromium darkens white to. */
const DARK_CANVAS = '#121212'
const LIGHT_CANVAS = '#ffffff'

/** Frames are attached as they appear, never paused for it: a frame paused
 *  until the debugger lets it go can stay paused for good when the release
 *  lands too early (seen in Electron 41), and the look lands before the
 *  frame's first paint anyway. */
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
}

const NEUTRAL: DarkPageLook = { dark: false, repaint: false, rule: null }

const PREFERS_DARK = { name: 'prefers-color-scheme', value: 'dark' }

/** How long a page that no longer needs the session keeps it, its look
 *  already taken off: its document drops the guard stylesheet first, which
 *  would black the page out the moment the session's marker went. */
const RELEASE_DELAY_MS = 300

interface Page {
  wc: WebContents
  /** Tabs: their view's resting colour (null = the view's own); popups:
   *  their window's. */
  setBackground: (color: string | null) => void
  /** A popup window paints white where the page paints nothing; a tab's
   *  view is see-through, onto Vimperium's own background. */
  opaque: boolean
  held: boolean
  /** The look the session was last given, null when it hasn't been. */
  applied: DarkPageLook | null
  /** The address the look is for. */
  url: string
  /** Sessions of the page's out-of-process frames. */
  frames: Set<string>
  /** The comfort CSS the page's document has. */
  css: string
  background: string | null
  failures: number
  /** When the session last ended under us, to stop re-taking one that keeps
   *  ending. */
  endedAt: number[]
  /** Letting go of the session, once the document has dropped its guard. */
  releaseTimer: ReturnType<typeof setTimeout> | null
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: (event: unknown, reason: string) => void
}

const store = new Store<{ config: DarkPagesConfig }>({
  name: 'vimperium-dark-pages',
  defaults: { config: DEFAULT_DARK_PAGES },
})

let config: DarkPagesConfig = normalizeDarkPages(store.get('config'))
let appDark = false
const pages = new Map<number, Page>()

// A slider dragged changes the config many times a second: apply each at
// once, write the last.
const PERSIST_DELAY_MS = 400
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistSoon(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS)
}

function flushPersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  store.set('config', config)
}

function computeAppDark(): boolean {
  const theme = loadSettings().theme
  return theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors)
}

function safeUrl(wc: WebContents): string {
  try { return wc.isDestroyed() ? '' : wc.getURL() } catch { return '' }
}

function sameLook(a: DarkPageLook | null, b: DarkPageLook): boolean {
  return !!a && a.dark === b.dark && a.repaint === b.repaint
}

/** Settles when the command is done, failed or not. */
function command(page: Page, method: string, params: object, sessionId?: string): Promise<void> {
  if (page.wc.isDestroyed() || !page.wc.debugger.isAttached()) return Promise.resolve()
  return page.wc.debugger.sendCommand(method, params, sessionId).then(() => {}, (err: unknown) => {
    // A frame that went away before its command arrived is no news.
    if (sessionId && !page.frames.has(sessionId)) return
    if (page.failures++ < 5) log.warn('dark-pages: command failed', { method, sessionId, err: String(err) })
  })
}

/** Give the page's root (no session) or one of its frames a look — and the
 *  session's marker, whatever the look (see darkPageCss). */
function sendLook(page: Page, sessionId: string | undefined, look: DarkPageLook): Promise<void> {
  return Promise.all([
    command(page, 'Emulation.setAutoDarkModeOverride', look.repaint ? { enabled: true } : {}, sessionId),
    command(page, 'Emulation.setEmulatedMedia', {
      features: look.dark ? [SESSION_MARKER, PREFERS_DARK] : [SESSION_MARKER],
    }, sessionId),
  ]).then(() => {})
}

function lookOf(page: Page): DarkPageLook {
  return darkPageLook(config, page.url, appDark)
}

function takeHold(page: Page): boolean {
  if (!holdDebugger(page.wc, 'dark-pages')) return false
  page.held = true
  page.applied = null
  page.frames.clear()
  page.wc.debugger.on('message', page.onMessage)
  page.wc.debugger.on('detach', page.onDetach)
  command(page, 'Target.setAutoAttach', AUTO_ATTACH)
  return true
}

function dropListeners(page: Page): void {
  if (page.wc.isDestroyed()) return
  page.wc.debugger.removeListener('message', page.onMessage)
  page.wc.debugger.removeListener('detach', page.onDetach)
}

function forget(page: Page): void {
  if (page.releaseTimer) clearTimeout(page.releaseTimer)
  page.releaseTimer = null
  dropListeners(page)
  page.held = false
  page.applied = null
  page.frames.clear()
}

/** No page can be dark now: take the look off at once, and the session
 *  after the document has dropped its guard. */
function letGo(page: Page): void {
  if (!page.held || page.releaseTimer) return
  if (!sameLook(page.applied, NEUTRAL)) {
    page.applied = NEUTRAL
    sendLook(page, undefined, NEUTRAL)
    for (const sessionId of page.frames) sendLook(page, sessionId, NEUTRAL)
  }
  page.releaseTimer = setTimeout(() => {
    page.releaseTimer = null
    if (page.wc.isDestroyed() || !page.held || darkPagesInUse(config, appDark)) return
    // An extension holding the session keeps it: take the marker off too.
    if (holdsDebugger(page.wc, 'extension')) {
      command(page, 'Emulation.setEmulatedMedia', { features: [] })
      for (const sessionId of page.frames) command(page, 'Emulation.setEmulatedMedia', { features: [] }, sessionId)
    }
    forget(page)
    releaseDebugger(page.wc, 'dark-pages')
    paint(page)
  }, RELEASE_DELAY_MS)
}

function paint(page: Page): void {
  const look = page.held ? page.applied : null
  const color = page.opaque
    ? look?.repaint ? DARK_CANVAS : LIGHT_CANVAS
    // A tab shows Vimperium's background through: dark already when Vimperium is.
    : look?.repaint && !appDark ? DARK_CANVAS : null
  if (color === page.background) return
  page.background = color
  try { page.setBackground(color) } catch (err) { log.warn('dark-pages: background failed', String(err)) }
}

function pushComfort(page: Page): void {
  const css = darkPageCss(config, page.held && page.applied ? page.applied : NEUTRAL)
  if (css === page.css || page.wc.isDestroyed()) return
  page.css = css
  try { page.wc.send('vimperium-dark-pages-css', css) } catch { /* page gone */ }
}

/** Bring a page in line with the config and its address. */
function sync(page: Page): void {
  if (page.wc.isDestroyed()) return
  if (!darkPagesInUse(config, appDark)) {
    letGo(page)
  } else if (page.held || takeHold(page)) {
    // In use again before the session went: keep it.
    if (page.releaseTimer) {
      clearTimeout(page.releaseTimer)
      page.releaseTimer = null
    }
    const look = lookOf(page)
    if (!sameLook(page.applied, look)) {
      page.applied = look
      sendLook(page, undefined, look)
      for (const sessionId of page.frames) sendLook(page, sessionId, look)
    }
  }
  paint(page)
  pushComfort(page)
}

function syncAll(): void {
  for (const page of pages.values()) sync(page)
}

function broadcast(): void {
  const payload = { config, appDark }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || pages.has(win.webContents.id)) continue
    win.webContents.send('dark-pages:updated', payload)
  }
}

function commit(next: DarkPagesConfig, why: string, fromSync = false): DarkPagesConfig {
  const normalized = normalizeDarkPages(next)
  if (JSON.stringify(normalized) === JSON.stringify(config)) return config
  const before = config
  config = normalized
  persistSoon()
  if (before.mode !== config.mode || before.style !== config.style || JSON.stringify(before.sites) !== JSON.stringify(config.sites)) {
    log.info('dark-pages: config', { why, mode: config.mode, style: config.style, sites: Object.keys(config.sites).length })
  }
  syncAll()
  broadcast()
  if (!fromSync) notifyCloudChange('darkPages')
  return config
}

/** Track a page — a tab's, or a popup a tab opened — for its whole life. */
export function trackDarkPages(wc: WebContents, opts: { setBackground: (color: string | null) => void; opaque?: boolean }): void {
  if (wc.isDestroyed() || pages.has(wc.id)) return
  const page: Page = {
    wc,
    setBackground: opts.setBackground,
    opaque: opts.opaque === true,
    held: false,
    applied: null,
    url: safeUrl(wc),
    frames: new Set(),
    css: '',
    background: null,
    failures: 0,
    endedAt: [],
    releaseTimer: null,
    onMessage: (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const p = params as { sessionId?: string; targetInfo?: { type?: string }; waitingForDebugger?: boolean }
        if (!p.sessionId || p.targetInfo?.type !== 'iframe') return
        // Frames of the page, or of its frames — not an extension's own.
        if (sessionId && !page.frames.has(sessionId)) return
        page.frames.add(p.sessionId)
        if (page.applied) sendLook(page, p.sessionId, page.applied)
        command(page, 'Target.setAutoAttach', AUTO_ATTACH, p.sessionId)
        // Only an extension asks frames to wait; with it gone nobody would
        // let this one go.
        if (p.waitingForDebugger && !holdsDebugger(wc, 'extension')) {
          const frame = p.sessionId
          setTimeout(() => command(page, 'Runtime.runIfWaitingForDebugger', {}, frame), 150)
        }
      } else if (method === 'Target.detachedFromTarget') {
        const p = params as { sessionId?: string }
        if (p.sessionId) page.frames.delete(p.sessionId)
      }
    },
    onDetach: (_event, reason) => {
      // The session ended under us — the renderer went away, say. Take it up
      // again for the page that comes next, unless it keeps ending: then the
      // next navigation tries again.
      forget(page)
      const now = Date.now()
      page.endedAt = [...page.endedAt.filter((t) => now - t < 10_000), now]
      log.info('dark-pages: session ended', { reason, recently: page.endedAt.length })
      if (page.endedAt.length <= 3) setTimeout(() => sync(page), 0)
    },
  }
  pages.set(wc.id, page)

  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    // Nothing on screen yet — a new tab, a lazy tab's first load: set the
    // look before the page commits. Otherwise the page on screen keeps its
    // look until the next one replaces it (did-navigate).
    const shown = safeUrl(wc)
    if (!page.applied || !shown || shown === 'about:blank') {
      page.url = details.url
      sync(page)
    }
  })
  wc.on('did-navigate', (_e, url) => {
    page.url = url
    sync(page)
  })
  wc.once('destroyed', () => {
    if (page.releaseTimer) clearTimeout(page.releaseTimer)
    pages.delete(wc.id)
  })
  sync(page)
}

/** How long a tab's first load waits for its look, at most. */
const FIRST_LOAD_WAIT_MS = 1500

/**
 * Before a tab's first load (main/tab-views.ts): a page that's to be dark
 * gets its look before its request goes out. The session's Emulation
 * commands take effect only once the page has a renderer, and a tab that has
 * loaded nothing gets its first with its first navigation — after the
 * request has gone out without the dark preference, so a site that picks its
 * theme on the server (Google, by the Sec-CH-Prefers-Color-Scheme client
 * hint) sends its light one, until a reload. So the tab loads about:blank
 * first and takes the look there; the page's own navigation then carries it
 * from its first request. True when it did: about:blank is then the first
 * entry of the tab's history.
 */
export async function readyDarkFirstLoad(wc: WebContents, url: string): Promise<boolean> {
  const page = pages.get(wc.id)
  if (!page || wc.isDestroyed() || !page.held || page.releaseTimer) return false
  // A document's there already: its renderer has had the look.
  if (safeUrl(wc)) return false
  const look = darkPageLook(config, url, appDark)
  if (!look.dark) return false
  try {
    await wc.loadURL('about:blank')
  } catch (err) {
    // ERR_ABORTED: another navigation of the tab's took over.
    if (!String(err).includes('ERR_ABORTED')) log.warn('dark-pages: about:blank before the first load failed', String(err))
    return false
  }
  if (wc.isDestroyed() || !page.held) return false
  // The look for the page to come, sent again now that there's a renderer
  // to take it.
  page.url = url
  page.applied = look
  let timer: ReturnType<typeof setTimeout> | null = null
  await Promise.race([
    sendLook(page, undefined, look),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, FIRST_LOAD_WAIT_MS) }),
  ])
  if (timer) clearTimeout(timer)
  paint(page)
  return true
}

/** The stylesheet for a document starting in a tracked page (sync IPC from
 *  the tab preload, before the document paints): the guard only while the
 *  session — and its marker — is there. */
function comfortFor(wc: WebContents, url: string): string {
  const page = pages.get(wc.id)
  if (!page) return ''
  const live = page.held && !page.releaseTimer && darkPagesInUse(config, appDark)
  const css = live ? darkPageCss(config, darkPageLook(config, url, appDark)) : ''
  page.css = css
  return css
}

/** An extension sharing a page's session (main/extensions/debugger.ts) sets
 *  emulated media its own way: keep the session's marker, and the page's
 *  dark preference, in what it sets — or the guard would black the page
 *  out. */
export function patchExtensionDebuggerCommand(wc: WebContents, method: string, params: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
  if (method !== 'Emulation.setEmulatedMedia') return params
  const page = pages.get(wc.id)
  if (!page?.held || (sessionId && !page.frames.has(sessionId))) return params
  const features = Array.isArray(params.features) ? [...(params.features as Array<{ name?: unknown }>)] : []
  const named = new Set(features.map((f) => f?.name))
  if (!named.has(SESSION_MARKER.name)) features.push(SESSION_MARKER)
  if (page.applied?.dark && !named.has(PREFERS_DARK.name)) features.push(PREFERS_DARK)
  return { ...params, features }
}

/** Vimperium's theme changed (Settings, or the OS under 'System'). */
export function refreshDarkPagesTheme(): void {
  const next = computeAppDark()
  if (next === appDark) return
  appDark = next
  syncAll()
  broadcast()
}

export function getDarkPagesConfig(): DarkPagesConfig {
  return config
}

/** Cloud Sync's copy from another device. */
export function applySyncedDarkPages(data: unknown): void {
  commit(normalizeDarkPages(data), 'cloud sync', true)
}

function setSiteRule(site: string, rule: DarkPagesRule | null): DarkPagesConfig {
  const key = normalizeSiteKey(site)
  if (!key) return config
  const sites = { ...config.sites }
  if (rule) sites[key] = rule
  else delete sites[key]
  return commit({ ...config, sites }, `site ${key}: ${rule ?? 'follows the switch'}`)
}

export function registerDarkPagesIpc(): void {
  appDark = computeAppDark()
  nativeTheme.on('updated', refreshDarkPagesTheme)
  app.on('before-quit', () => { if (persistTimer) flushPersist() })

  // Another holder letting go may have changed the session's frame
  // attaching: set it back up our way.
  onDebuggerReleased((wc, holder) => {
    if (holder === 'dark-pages') return
    const page = pages.get(wc.id)
    if (page?.held) command(page, 'Target.setAutoAttach', AUTO_ATTACH)
  })

  ipcMain.handle('dark-pages:get', () => ({ config, appDark }))
  ipcMain.handle('dark-pages:set', (_e, patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<DarkPagesConfig>
    // Sites go through set-site: a stale copy must not undo a toggle.
    const { sites: _sites, ...rest } = p
    return commit({ ...config, ...rest }, 'settings')
  })
  ipcMain.handle('dark-pages:set-site', (_e, site: unknown, rule: unknown) =>
    setSiteRule(String(site ?? ''), rule === 'dark' || rule === 'light' ? rule : null))
  ipcMain.handle('dark-pages:set-page', (_e, url: unknown, dark: unknown) => {
    const u = String(url ?? '')
    const site = siteKeyOf(u)
    if (!site || typeof dark !== 'boolean') return config
    return setSiteRule(site, siteRuleGiving(config, u, appDark, dark))
  })
  ipcMain.handle('dark-pages:toggle-site', (_e, url: unknown) => {
    const toggled = toggledSiteRule(config, String(url ?? ''), appDark)
    return toggled ? setSiteRule(toggled.site, toggled.rule) : config
  })
  ipcMain.handle('dark-pages:toggle', () =>
    commit({ ...config, mode: darkPagesGloballyOn(config, appDark) ? 'off' : 'on' }, 'toggle'))
  ipcMain.handle('dark-pages:reset-sites', () => commit({ ...config, sites: {} }, 'sites reset'))

  // The tab preload, as a document starts: its comfort filter, if any.
  ipcMain.on('dark-pages:comfort-css', (event, url: unknown) => {
    const frame = event.senderFrame
    event.returnValue = frame && !frame.parent ? comfortFor(event.sender, String(url ?? '')) : ''
  })
}
