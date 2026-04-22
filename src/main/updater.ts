import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { log } from './log'

/**
 * Auto-update status broadcast to the renderer. Kept intentionally small
 * and serializable — the UI just needs to know which phase we're in and a
 * version string / progress number / error message.
 */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'not-available'; version: string }
  | { phase: 'available'; version: string; releaseNotes?: string | null }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string; releaseNotes?: string | null }
  | { phase: 'error'; message: string }

let latestStatus: UpdateStatus = { phase: 'idle' }
let initialized = false

function broadcast(status: UpdateStatus): void {
  latestStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('updater:status', status)
    }
  }
}

export function getLatestStatus(): UpdateStatus {
  return latestStatus
}

/**
 * Wire up electron-updater. Must be called once from app.whenReady().
 * Safe to call in non-packaged builds — we simply no-op so developers
 * don't see spurious "update check failed" errors in dev.
 */
export function setupAutoUpdater(): void {
  if (initialized) return
  initialized = true

  // No-op in dev / non-packaged runs. electron-updater can't resolve an
  // app-update.yml outside of an installed build and would log warnings.
  if (!app.isPackaged) {
    log.info('updater: skipped (app is not packaged)')
    return
  }

  // Route updater logs through our existing logger so they show up in the
  // same log file as the rest of the app.
  const updaterLog = {
    info: (m: unknown) => log.info('updater:', m),
    warn: (m: unknown) => log.warn('updater:', m),
    error: (m: unknown) => log.error('updater:', m),
    debug: (m: unknown) => log.info('updater:debug:', m),
  }
  ;(autoUpdater as unknown as { logger: typeof updaterLog }).logger = updaterLog

  // Default electron-updater behavior: auto-download on detection, install
  // on quit. We surface the "ready, restart to apply" state in the UI so
  // the user can restart immediately if they want.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    broadcast({ phase: 'checking' })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    broadcast({ phase: 'not-available', version: info.version })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    broadcast({ phase: 'available', version: info.version, releaseNotes: notes })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    const last = latestStatus
    const version = last.phase === 'available' || last.phase === 'downloading' ? last.version : app.getVersion()
    broadcast({
      phase: 'downloading',
      version,
      percent: Math.round(p.percent),
      bytesPerSecond: Math.round(p.bytesPerSecond),
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    broadcast({ phase: 'downloaded', version: info.version, releaseNotes: notes })
  })

  autoUpdater.on('error', (err: Error) => {
    broadcast({ phase: 'error', message: err?.message || String(err) })
  })

  // Initial check shortly after startup — give the main window time to
  // mount so any early "update available" event lands in a live renderer.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('updater: initial check failed', err)
    })
  }, 8000)

  // Follow-up checks while the app is running. 6h is a reasonable cadence
  // for a tool that most users leave open all day.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('updater: periodic check failed', err)
    })
  }, 6 * 60 * 60 * 1000)
}

/** User-triggered explicit check (e.g. "Check for updates" menu item). */
export async function checkForUpdatesNow(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    // Dev mode: electron-updater is a no-op, but we still want the UI to
    // acknowledge the click. Simulate a quick check → up-to-date flip so
    // subscribers (banner, settings) can display feedback.
    broadcast({ phase: 'checking' })
    const v = app.getVersion()
    const result: UpdateStatus = { phase: 'not-available', version: v }
    setTimeout(() => broadcast(result), 400)
    return result
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    broadcast({ phase: 'error', message })
  }
  return latestStatus
}

/** Manually kick off a download if we aren't on autoDownload. */
export async function downloadUpdateNow(): Promise<void> {
  if (!app.isPackaged) return
  await autoUpdater.downloadUpdate()
}

/** Quit and install the downloaded update. Must only be called when
 * the phase is 'downloaded' — otherwise electron-updater will throw. */
export function installUpdateNow(): void {
  if (!app.isPackaged) return
  // isSilent: false — show the installer UI so the user sees progress.
  // isForceRunAfter: true — relaunch the app after the install completes.
  autoUpdater.quitAndInstall(false, true)
}
