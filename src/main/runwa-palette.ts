import { app, screen, type Rectangle } from 'electron'
import { closeSync, existsSync, openSync, readFileSync, readlinkSync } from 'fs'
import { join } from 'path'
import { log } from './log'

// Runwa is the sibling command-palette launcher. Its window switcher, app
// launcher and command palette all share one search window, and Runwa
// remembers the size and position the user gives it. While Runwa is running,
// Newbro's palette-style popups (Command Palette, Search, the pickers) open
// at that same geometry so every search box on the machine lands in one
// spot. Runwa owns the values and Newbro only reads them, fresh on every
// open, so resizing Runwa's palette shows up on the next Newbro palette with
// nothing to sync.

/** Token a renderer puts in `window.open`'s features string to ask for this
 *  geometry. Mirrored in src/renderer/src/components/DetachedWindow.tsx. */
const RUNWA_PALETTE_FEATURE = 'newbro-runwa-palette'

/** Runwa's userData folder names under appData: the installed build, then
 *  `npm run dev`. The first one that's running wins. */
const RUNWA_USER_DATA_DIRS = ['Runwa', 'Runwa Dev']

// Mirrors runwa/src/main/palette-window.ts, so with nothing stored (or a
// stored position that's gone offscreen) Newbro opens exactly where Runwa's
// own palette would.
const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 520
const MIN_WIDTH = 480
const MIN_HEIGHT = 320
const MIN_VISIBLE_INTERSECTION_WIDTH = 80
const MIN_VISIBLE_INTERSECTION_HEIGHT = 60

interface RunwaPaletteSettings {
  paletteSize?: { width?: unknown; height?: unknown }
  palettePosition?: { x?: unknown; y?: unknown }
}

export function wantsRunwaPaletteGeometry(features: string): boolean {
  return features.split(',').some((f) => f.split('=')[0].trim() === RUNWA_PALETTE_FEATURE)
}

/**
 * Whether the Electron app owning `userDataDir` is running, judged by
 * Chromium's process-singleton lock rather than a process-list scan (no
 * child process, no executable-name guessing, works for an elevated Runwa).
 *
 * Windows: `lockfile` is held open without write sharing for the life of the
 * process and deleted on close, but a power loss can leave it behind, so a
 * file we can open ourselves is stale. Elsewhere: `SingletonLock` is a
 * symlink to `<hostname>-<pid>`, which is stale once that pid is gone.
 */
function isRunning(userDataDir: string): boolean {
  if (process.platform === 'win32') {
    const lockfile = join(userDataDir, 'lockfile')
    if (!existsSync(lockfile)) return false
    try {
      closeSync(openSync(lockfile, 'r+'))
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    }
  }
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(join(userDataDir, 'SingletonLock')))?.[1])
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readSettings(userDataDir: string): RunwaPaletteSettings | null {
  try {
    return JSON.parse(readFileSync(join(userDataDir, 'runwa-settings.json'), 'utf8'))
  } catch {
    return null
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function hasEnoughVisibleArea(rect: Rectangle): boolean {
  return screen.getAllDisplays().some(({ workArea: area }) => {
    const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
    const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
    return width >= MIN_VISIBLE_INTERSECTION_WIDTH && height >= MIN_VISIBLE_INTERSECTION_HEIGHT
  })
}

function paletteBounds(settings: RunwaPaletteSettings): Rectangle {
  const width = Math.max(num(settings.paletteSize?.width) ?? DEFAULT_WIDTH, MIN_WIDTH)
  const height = Math.max(num(settings.paletteSize?.height) ?? DEFAULT_HEIGHT, MIN_HEIGHT)
  const x = num(settings.palettePosition?.x)
  const y = num(settings.palettePosition?.y)
  if (x !== undefined && y !== undefined && hasEnoughVisibleArea({ x, y, width, height })) {
    return { x, y, width, height }
  }
  // Runwa's fallback: centered on the cursor's display, in the upper third.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.28),
    width,
    height,
  }
}

/** Last outcome logged, so the log records changes (Runwa started, stopped,
 *  palette moved) instead of one line per palette open. */
let lastLogged: string | null = null

function logOnChange(line: string): void {
  if (line === lastLogged) return
  lastLogged = line
  log.info(`[runwa-palette] ${line}`)
}

/** Bounds of Runwa's search window in screen DIPs, or null when Runwa isn't
 *  running (or its settings can't be read) and the popup keeps its own. */
export function runwaPaletteBounds(): Rectangle | null {
  for (const name of RUNWA_USER_DATA_DIRS) {
    const dir = join(app.getPath('appData'), name)
    if (!isRunning(dir)) continue
    const settings = readSettings(dir)
    if (!settings) {
      logOnChange(`${name} is running but its settings are unreadable, using Newbro's bounds`)
      return null
    }
    const b = paletteBounds(settings)
    logOnChange(`${name} is running, palettes open at ${b.width}x${b.height}@${b.x},${b.y}`)
    return b
  }
  logOnChange("Runwa isn't running, using Newbro's bounds")
  return null
}
