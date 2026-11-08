// "Are you sure?" in a popup of its own. The confirm button has the keyboard
// (Enter); y says yes and n no from anywhere in it, Esc is no — the keys
// along its bottom, as on every keyboard surface.

import { useEffect, useRef, useState } from 'react'
import { DetachedWindow } from './DetachedWindow'
import { Hint, HintBar } from './KeyHints'
import { useYesNoKeys } from '../lib/dialog-keys'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  tone?: 'destructive' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Yes, I'm sure", tone = 'destructive', onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const [popup, setPopup] = useState<Window | null>(null)

  useEffect(() => {
    if (open) setTimeout(() => confirmRef.current?.focus(), 50)
  }, [open])

  // Esc is the popup's own (DetachedWindow closes on it, which cancels).
  useYesNoKeys(popup, { yes: onConfirm, no: onCancel, enabled: open })

  if (!open) return null

  return (
    <DetachedWindow open={open} title={title} width={460} height={260} resizable={false} onClose={onCancel} onWindowChange={setPopup}>
      <div className="h-full bg-popover text-popover-foreground flex flex-col">
        <div className="flex-1 min-h-0 p-5 flex flex-col">
          <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
          <p className="text-sm text-muted-foreground mb-4">{message}</p>
          <div className="flex justify-end gap-2 mt-auto">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              ref={confirmRef}
              onClick={onConfirm}
              className={`h-8 px-3 rounded-md text-xs font-medium hover:opacity-90 ${
                tone === 'primary'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-destructive text-destructive-foreground'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
        <HintBar>
          <Hint label="Yes" keys={['y']} />
          <Hint label="No" keys={['n', 'Esc']} />
        </HintBar>
      </div>
    </DetachedWindow>
  )
}
