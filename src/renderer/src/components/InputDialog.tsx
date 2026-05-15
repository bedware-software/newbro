import { useState, useEffect, useRef } from 'react'
import { DetachedWindow } from './DetachedWindow'

interface Props {
  open: boolean
  title: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function InputDialog({ open, title, placeholder, defaultValue = '', confirmLabel = 'Create', onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(defaultValue)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [open, defaultValue])

  const handleSubmit = () => {
    if (value.trim()) {
      onConfirm(value.trim())
    }
  }

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title={title}
      width={440}
      height={210}
      resizable={false}
      // Click-away dismiss so the dialog behaves like a real modal —
      // without this it can hide behind the main window and the user
      // has to alt-tab to find it. Esc + Cancel still work as the
      // explicit dismiss paths; closeOnBlur is the "I clicked
      // somewhere else" path.
      closeOnBlur
      onClose={onCancel}
    >
      <div className="h-full bg-popover text-popover-foreground p-4 flex flex-col">
        <h3 className="text-sm font-semibold text-foreground mb-3">{title}</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={placeholder}
          className="w-full h-9 px-3 rounded-md bg-secondary border border-input text-sm text-foreground outline-none focus:border-ring focus:bg-background"
        />
        <div className="flex justify-end gap-2 mt-auto pt-3">
          <button
            onClick={onCancel}
            className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </DetachedWindow>
  )
}
