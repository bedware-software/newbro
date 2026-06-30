import { useEffect, useState } from 'react'
import { Cloud, FolderOpen } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { log } from '../lib/log'
import type { CloudSyncInfo, CloudSyncSetupPrompt } from '../App'

interface Props {
  open: boolean
  prompt: CloudSyncSetupPrompt
  /** Close for this launch. The offer reappears next launch unless the user
   *  enabled sync or chose "Don't show again" (both handled in main). */
  onClose: () => void
}

/** First-run offer to turn on Cloud Sync. Defaults to an iCloud Drive folder
 *  when one is detected, but the user can pick any folder their cloud client
 *  mirrors (OneDrive / Dropbox / Google Drive). The first reconcile can take a
 *  while (downloading another device's data), so we show a progress bar and
 *  keep the app responsive — see the async/timeout reads in cloud-sync.ts. */
export function CloudSyncSetupDialog({ open, prompt, onClose }: Props) {
  const [phase, setPhase] = useState<'offer' | 'syncing'>('offer')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<CloudSyncInfo | null>(null)
  const { icloudAvailable, suggestedFolder } = prompt

  // Live status drives the progress bar while the first reconcile runs.
  useEffect(() => {
    if (!open) return
    const cleanup = window.electronAPI.onCloudSyncStatus?.((i) => setStatus(i))
    return cleanup
  }, [open])

  // Run an enable action, showing the syncing view + progress while it works.
  const runSetup = async (begin: () => Promise<CloudSyncInfo>): Promise<void> => {
    setError(null)
    setPhase('syncing')
    try {
      const info = await begin()
      if (info.state === 'error') {
        setPhase('offer')
        setError(info.error ?? 'Sync failed. Check the folder and try again.')
        return
      }
      if (info.enabled) { onClose(); return }
      setPhase('offer')
      setError('Could not set up that folder. Try choosing one instead.')
    } catch (err) {
      log.error('cloud-sync setup failed', { err: String(err) })
      setPhase('offer')
      setError('Something went wrong setting up sync.')
    }
  }

  const enableSuggested = (): void => {
    if (!suggestedFolder) return
    void runSetup(() => window.electronAPI.cloudSyncSetupWithFolder(suggestedFolder))
  }

  const chooseFolder = async (): Promise<void> => {
    setError(null)
    try {
      const picked = await window.electronAPI.cloudSyncSetFolder()
      // Empty folderPath ⇒ the user cancelled the native picker; keep the offer.
      if (!picked.folderPath) return
      await runSetup(() => window.electronAPI.cloudSyncSetEnabled(true))
    } catch (err) {
      log.error('cloud-sync choose-folder failed', { err: String(err) })
      setError('Something went wrong setting up sync.')
    }
  }

  const dontShowAgain = async (): Promise<void> => {
    try { await window.electronAPI.cloudSyncDismissPrompt() } catch { /* best-effort */ }
    onClose()
  }

  if (!open) return null

  const progress = status?.progress ?? null
  const pct = progress && progress.total > 0
    ? Math.max(8, Math.round((progress.done / progress.total) * 100))
    : null
  const busy = phase === 'syncing'

  return (
    <DetachedWindow
      open={open}
      title="Set up Cloud Sync - Newbro"
      width={520}
      height={360}
      resizable={false}
      closeOnEscape
      alwaysOnTop
      onClose={onClose}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div data-detached-drag-handle className="flex items-center gap-3 px-5 pt-5 pb-3 shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary shrink-0">
            <Cloud size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Set up Cloud Sync</h3>
            <p className="text-[11px] text-muted-foreground">Keep tabs, workspaces, settings and more in sync across your devices.</p>
          </div>
        </div>

        <div className="flex-1 px-5 overflow-y-auto">
          {busy ? (
            <div className="py-2">
              <p className="text-xs text-foreground mb-2">Setting up sync…</p>
              <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className={`h-full bg-primary transition-all duration-300 ${pct === null ? 'animate-pulse' : ''}`}
                  style={{ width: pct === null ? '15%' : `${pct}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                {progress
                  ? `Syncing ${progress.done} of ${progress.total}…`
                  : 'Preparing… (downloading data from your other devices may take a moment)'}
              </p>
            </div>
          ) : (
            <>
              {icloudAvailable ? (
                <>
                  <p className="text-xs text-muted-foreground mb-2">
                    We found iCloud Drive on this device. We can sync into this folder:
                  </p>
                  <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/50 px-3 py-2 mb-3">
                    <FolderOpen size={14} className="text-muted-foreground shrink-0" />
                    <span className="text-xs text-foreground truncate" title={suggestedFolder ?? undefined}>
                      {suggestedFolder}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground mb-3">
                  iCloud Drive wasn&apos;t found. Pick any folder that your cloud client
                  (OneDrive, Dropbox, Google Drive…) already keeps in sync across devices.
                </p>
              )}

              <p className="text-[11px] text-muted-foreground/80">
                Your data is mirrored into the folder and merged across devices (last write wins).
                Nothing is sent to Newbro — only your own cloud handles the transfer.
              </p>

              {error && <p className="text-[11px] text-destructive mt-3">{error}</p>}
            </>
          )}
        </div>

        {!busy && (
          <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-border bg-toolbar shrink-0">
            <button
              onClick={dontShowAgain}
              className="h-8 px-2 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              Don&apos;t show again
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
              >
                Not now
              </button>
              {icloudAvailable ? (
                <>
                  <button
                    onClick={chooseFolder}
                    className="h-8 px-3 rounded-md text-xs font-medium text-foreground hover:bg-accent"
                  >
                    Choose folder…
                  </button>
                  <button
                    onClick={enableSuggested}
                    className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
                  >
                    Sync with iCloud
                  </button>
                </>
              ) : (
                <button
                  onClick={chooseFolder}
                  className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
                >
                  Choose folder…
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </DetachedWindow>
  )
}
