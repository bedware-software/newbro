import { useEffect, useRef } from 'react'
import { DetachedWindow } from './DetachedWindow'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Yes, I'm sure", onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => confirmRef.current?.focus(), 50)
  }, [open])

  if (!open) return null

  return (
    <DetachedWindow open={open} title={title} width={460} height={220} resizable={false} onClose={onCancel}>
      <div className="h-full bg-popover text-popover-foreground p-5 flex flex-col">
        <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground mb-4">{message}</p>
        <div className="flex justify-end gap-2 mt-auto">
          <button
            onClick={onCancel}
            className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}
            className="h-8 px-3 rounded-md text-xs font-medium bg-destructive text-destructive-foreground hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </DetachedWindow>
  )
}
