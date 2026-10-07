import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Puzzle } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import { ExtensionPermissionList } from './ExtensionPermissionList'
import { describeExtensionPermissions } from '../lib/extension-permissions'

export interface ExtensionInstallPreview {
  id: string
  name: string
  version: string
  description?: string
  iconUrl: string | null
  permissions: string[]
  hostPermissions: string[]
  optionalPermissions: string[]
  contentScriptMatches: string[]
  installedVersion: string | null
}

interface Props {
  preview: ExtensionInstallPreview | null
  installing: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
}

/** "Add <name>?" — Chrome's install prompt: what the extension can do,
 *  every permission it declares on demand, and nothing installed until the
 *  user agrees. */
export function ExtensionInstallDialog({ preview, installing, error, onConfirm, onCancel }: Props) {
  const [showAll, setShowAll] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setShowAll(false)
    if (preview) setTimeout(() => confirmRef.current?.focus(), 50)
  }, [preview])

  if (!preview) return null

  const warnings = describeExtensionPermissions(preview)
  const update = preview.installedVersion !== null
  const title = update ? `Reinstall “${preview.name}”?` : `Add “${preview.name}”?`

  return (
    <DetachedWindow
      open
      title={title}
      width={460}
      height={480}
      closeOnEscape={!installing}
      onClose={() => {
        if (!installing) onCancel()
      }}
    >
      <div className="flex h-full flex-col bg-popover text-popover-foreground">
        <div className="flex items-start gap-3 px-5 pt-5 pb-3" data-detached-drag-handle>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            {preview.iconUrl ? (
              <img src={preview.iconUrl} className="h-10 w-10" alt="" />
            ) : (
              <Puzzle size={18} className="text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-[11px] text-muted-foreground">
              v{preview.version}
              {update ? ` · installed v${preview.installedVersion}` : ''}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3" data-detached-no-drag>
          {preview.description && <p className="mb-3 text-xs text-muted-foreground">{preview.description}</p>}
          <div className="mb-2 text-xs font-medium text-foreground">It can:</div>
          {showAll ? (
            <ExtensionPermissionList
              permissions={preview.permissions}
              hostPermissions={preview.hostPermissions}
              optionalPermissions={preview.optionalPermissions}
              contentScriptMatches={preview.contentScriptMatches}
            />
          ) : warnings.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {warnings.map((w) => (
                <li key={w} className="flex items-start gap-2 text-xs text-foreground leading-relaxed">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Needs no special permissions.</p>
          )}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showAll ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {showAll ? 'Hide permission list' : 'Show all permissions'}
          </button>
          {error && (
            <div className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            onClick={onCancel}
            disabled={installing}
            className="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={installing}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
          >
            {installing && <Loader2 size={12} className="animate-spin" />}
            {installing ? 'Installing…' : update ? 'Reinstall' : 'Add extension'}
          </button>
        </div>
      </div>
    </DetachedWindow>
  )
}
