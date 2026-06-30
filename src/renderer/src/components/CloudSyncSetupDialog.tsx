import { useState } from 'react'
import { Cloud, FolderOpen } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { log } from '../lib/log'
import type { CloudSyncSetupPrompt } from '../App'

interface Props {
  open: boolean
  prompt: CloudSyncSetupPrompt
  /** Close for this launch. The offer reappears next launch unless the user
   *  enabled sync or chose "Don't show again" (both handled in main). */
  onClose: () => void
}

/** First-run offer to turn on Cloud Sync. Defaults to an iCloud Drive folder
 *  when one is detected, but the user can pick any folder their cloud client
 *  mirrors (OneDrive / Dropbox / Google Drive). */
export function CloudSyncSetupDialog({ open, prompt, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { icloudAvailable, suggestedFolder } = prompt

  const enableSuggested = async (): Promise<void> => {
    if (!suggestedFolder || busy) return
    setBusy(true)
    setError(null)
    try {
      const info = await window.electronAPI.cloudSyncSetupWithFolder(suggestedFolder)
      if (info.enabled) onClose()
      else setError('Could not set up that folder. Try choosing one instead.')
    } catch (err) {
      log.error('cloud-sync setup failed', { err: String(err) })
      setError('Something went wrong setting up sync.')
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const picked = await window.electronAPI.cloudSyncSetFolder()
      // Empty folderPath ⇒ the user cancelled the native picker; keep the offer.
      if (!picked.folderPath) return
      const info = await window.electronAPI.cloudSyncSetEnabled(true)
      if (info.enabled) onClose()
      else setError('Could not enable sync for that folder.')
    } catch (err) {
      log.error('cloud-sync choose-folder failed', { err: String(err) })
      setError('Something went wrong setting up sync.')
    } finally {
      setBusy(false)
    }
  }

  const dontShowAgain = async (): Promise<void> => {
    if (busy) return
    try { await window.electronAPI.cloudSyncDismissPrompt() } catch { /* best-effort */ }
    onClose()
  }

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Set up Cloud Sync - Newbro"
      width={520}
      height={360}
      resizable={false}
      closeOnEscape
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
          {icloudAvailable ? (
            <>
              <p className="text-xs text-muted-foreground mb-2">
                We found iCloud Drive on this Mac/PC. We can sync into this folder:
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
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-border bg-toolbar shrink-0">
          <button
            onClick={dontShowAgain}
            disabled={busy}
            className="h-8 px-2 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Don&apos;t show again
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Not now
            </button>
            {icloudAvailable ? (
              <>
                <button
                  onClick={chooseFolder}
                  disabled={busy}
                  className="h-8 px-3 rounded-md text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
                >
                  Choose folder…
                </button>
                <button
                  onClick={enableSuggested}
                  disabled={busy}
                  className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? 'Setting up…' : 'Sync with iCloud'}
                </button>
              </>
            ) : (
              <button
                onClick={chooseFolder}
                disabled={busy}
                className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {busy ? 'Setting up…' : 'Choose folder…'}
              </button>
            )}
          </div>
        </div>
      </div>
    </DetachedWindow>
  )
}
