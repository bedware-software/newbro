import { app, BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { log } from './log'

const isMac = process.platform === 'darwin'

// Path to the .zip electron-updater downloaded for the pending update.
// Captured on darwin in 'update-downloaded' so installUpdateNow() can
// hand it to our custom installer instead of Squirrel.Mac (which rejects
// our ad-hoc-signed builds with "code failed to satisfy specified code
// requirement(s)").
let downloadedZipPath: string | null = null

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
  // Unpacked / development build — electron-updater can't resolve an
  // app-update.yml, so we don't pretend to check. UI uses this to disable
  // the "check for updates" buttons and explain why.
  | { phase: 'unsupported' }

let latestStatus: UpdateStatus = { phase: 'idle' }
let initialized = false

// Network failures that are artifacts of the machine suspending/resuming
// rather than real update failures. Waking from hibernate fires the overdue
// periodic check before Wi-Fi has re-associated, so the request dies with one
// of these. Surfacing the "Update check failed" toast for them is a false
// positive — we swallow them and quietly retry once connectivity is back.
const TRANSIENT_NET_ERROR_CODES = [
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
]

function isTransientNetworkError(message: string): boolean {
  return TRANSIENT_NET_ERROR_CODES.some((code) => message.includes(code))
}

// Backoff retry state for transient (network-not-ready) check failures.
let transientRetryTimer: ReturnType<typeof setTimeout> | null = null
let transientRetryAttempts = 0
const MAX_TRANSIENT_RETRIES = 5

function scheduleTransientRetry(): void {
  if (transientRetryTimer) return
  if (transientRetryAttempts >= MAX_TRANSIENT_RETRIES) {
    transientRetryAttempts = 0
    return
  }
  transientRetryAttempts += 1
  // 15s, 30s, 60s, 120s, capped at 2min — enough headroom for Wi-Fi to come up.
  const delay = Math.min(15_000 * 2 ** (transientRetryAttempts - 1), 120_000)
  transientRetryTimer = setTimeout(() => {
    transientRetryTimer = null
    autoUpdater.checkForUpdates().catch((err) => {
      log.warn('updater: transient retry check failed', err)
    })
  }, delay)
}

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
  // Surface this to the UI so the "check for updates" affordances can be
  // disabled instead of silently misleading the user.
  if (!app.isPackaged) {
    log.info('updater: skipped (app is not packaged)')
    latestStatus = { phase: 'unsupported' }
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
  // On darwin we run our own swap-and-relaunch script in installUpdateNow,
  // so don't let Squirrel attempt the install on quit either — it would
  // fail with the same signature-mismatch error.
  autoUpdater.autoInstallOnAppQuit = !isMac

  autoUpdater.on('checking-for-update', () => {
    broadcast({ phase: 'checking' })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    transientRetryAttempts = 0
    broadcast({ phase: 'not-available', version: info.version })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    transientRetryAttempts = 0
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
    const dlFile = (info as unknown as { downloadedFile?: string }).downloadedFile
    if (isMac && typeof dlFile === 'string' && dlFile.length > 0) {
      downloadedZipPath = dlFile
      log.info('updater: mac zip ready at', dlFile)
    }
    const notes = typeof info.releaseNotes === 'string' ? info.releaseNotes : null
    broadcast({ phase: 'downloaded', version: info.version, releaseNotes: notes })
  })

  autoUpdater.on('error', (err: Error) => {
    const message = err?.message || String(err)
    if (isTransientNetworkError(message)) {
      // False positive (e.g. waking from hibernate before Wi-Fi is up). Don't
      // show the sticky "Update check failed" toast — clear any in-flight
      // "checking" toast and retry once the network has likely settled. A
      // previously meaningful state (downloaded/available) is left untouched.
      log.info('updater: transient network error ignored, will retry:', message)
      if (latestStatus.phase === 'checking') broadcast({ phase: 'idle' })
      scheduleTransientRetry()
      return
    }
    broadcast({ phase: 'error', message })
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
    // Dev mode: electron-updater can't resolve update metadata. Don't
    // pretend the check ran — return the 'unsupported' state so the UI
    // can show why the action is disabled.
    const result: UpdateStatus = { phase: 'unsupported' }
    broadcast(result)
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

  if (isMac) {
    if (!downloadedZipPath) {
      const message = 'No downloaded update available to install'
      log.error('updater:', message)
      broadcast({ phase: 'error', message })
      return
    }
    runMacInstall(downloadedZipPath)
    return
  }

  // isSilent: false — show the installer UI so the user sees progress.
  // isForceRunAfter: true — relaunch the app after the install completes.
  autoUpdater.quitAndInstall(false, true)
}

// macOS install: bypass Squirrel.Mac (which validates code signatures and
// rejects our ad-hoc-signed builds). Spawn a detached bash script that
// waits for us to exit, swaps the .app bundle for the freshly downloaded
// one, and relaunches.
function runMacInstall(zipPath: string): void {
  // app.getPath('exe') -> /…/Newbro.app/Contents/MacOS/Newbro
  // dirname x3 walks up to the .app bundle.
  const exePath = app.getPath('exe')
  const appBundlePath = dirname(dirname(dirname(exePath)))
  const appName = app.getName()

  const scriptDir = mkdtempSync(join(tmpdir(), 'newbro-update-'))
  const scriptPath = join(scriptDir, 'install.sh')
  const logPath = join(app.getPath('logs'), `mac-update-${Date.now()}.log`)

  const script = `#!/bin/bash
set -u
OLD_APP="$1"
NEW_ZIP="$2"
APP_NAME="$3"
LOG="$4"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "[$(date)] mac-updater: starting"
echo "  OLD_APP=$OLD_APP"
echo "  NEW_ZIP=$NEW_ZIP"

# Wait for the current app to exit. Poll the bundle's main executable;
# pgrep -f matches anything still running from inside it.
for i in $(seq 1 60); do
  if ! pgrep -f "$OLD_APP/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Extra grace period in case fs handles are still being released.
sleep 1

WORK_DIR="$(mktemp -d -t newbro-update)"
echo "  WORK_DIR=$WORK_DIR"

if ! /usr/bin/ditto -x -k "$NEW_ZIP" "$WORK_DIR"; then
  echo "  ditto extract failed"
  exit 1
fi

NEW_APP="$WORK_DIR/$APP_NAME.app"
if [ ! -d "$NEW_APP" ]; then
  echo "  expected $NEW_APP not found, contents:"
  ls -la "$WORK_DIR"
  exit 1
fi

BACKUP="$OLD_APP.bak.$$"
if ! mv "$OLD_APP" "$BACKUP"; then
  echo "  backup move failed (permissions?)"
  exit 1
fi

if ! mv "$NEW_APP" "$OLD_APP"; then
  echo "  swap failed, restoring"
  mv "$BACKUP" "$OLD_APP"
  exit 1
fi

# Clear quarantine so Gatekeeper doesn't re-prompt on first launch.
/usr/bin/xattr -dr com.apple.quarantine "$OLD_APP" 2>/dev/null || true

# Relaunch via 'open' so launchd owns the new process, not this script.
/usr/bin/open "$OLD_APP"

# Cleanup. Failure here is harmless.
rm -rf "$BACKUP" "$WORK_DIR"
echo "[$(date)] mac-updater: done"
`

  writeFileSync(scriptPath, script, 'utf8')
  chmodSync(scriptPath, 0o755)

  log.info('updater: spawning mac install script', scriptPath, 'log:', logPath)
  const child = spawn('/bin/bash', [scriptPath, appBundlePath, zipPath, appName, logPath], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  // Give the spawn a moment to land before we tear ourselves down.
  setTimeout(() => app.quit(), 500)
}
