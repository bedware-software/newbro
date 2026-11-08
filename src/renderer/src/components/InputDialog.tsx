// Asks for a name (a new group, a rename) or a line of text (a tab's
// comment) in a popup of its own. Enter takes it from anywhere in it. In Vim
// mode the box has the two modes the other popups' boxes have: it opens
// typing (INSERT); Esc goes to COMMAND, where i types again and Esc cancels.

import { useState, useEffect, useMemo, useRef } from 'react'
import { DetachedWindow } from './DetachedWindow'
import { InputField } from './InputField'
import { Hint, HintBar, vimKeyCaps } from './KeyHints'
import { usePopupVimMode } from '../lib/vim-mode'
import { paletteKeymap } from '../lib/vim-keymap'
import { keymapOnly, useWindowVimKeymap } from '../lib/window-vim-keymap'

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

  // ── Vim mode ──
  // COMMAND's one key of its own is the one that types again (i); Enter
  // and Esc are the dialog's. Null while Vim mode is off.
  const [popup, setPopup] = useState<Window | null>(null)
  const parsedKeymap = useWindowVimKeymap()
  const vimKeymap = useMemo(
    () => (parsedKeymap ? keymapOnly(paletteKeymap(parsedKeymap.search), ['insert-mode']) : null),
    [parsedKeymap],
  )
  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup,
    box: inputRef,
    initial: 'insert',
    open,
    onCommand: (command) => { if (command === 'insert-mode') inputRef.current?.focus() },
    onEscape: onCancel,
    intercept: (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.shiftKey) return false
      handleSubmit()
      return true
    },
  })

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title={title}
      width={440}
      height={250}
      resizable={false}
      // Click-away dismiss so the dialog behaves like a real modal —
      // without this it can hide behind the main window and the user
      // has to alt-tab to find it. Esc + Cancel still work as the
      // explicit dismiss paths; closeOnBlur is the "I clicked
      // somewhere else" path.
      closeOnBlur
      // In Vim mode Esc first leaves the box; the dialog handles it.
      closeOnEscape={!vimKeymap}
      onClose={onCancel}
      onWindowChange={setPopup}
    >
      <div className="h-full bg-popover text-popover-foreground flex flex-col">
        <div className="flex-1 min-h-0 p-4 flex flex-col">
          <h3 className="text-sm font-semibold text-foreground mb-3">{title}</h3>
          <InputField inputRef={inputRef} mode={vim.mode} pending={vim.pending} className="h-9">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleSubmit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  // Kept from the popup's own Esc (closing) in both modes.
                  e.stopPropagation()
                  if (vim.modeRef.current) inputRef.current?.blur()
                  else onCancel()
                }
              }}
              onFocus={vim.onBoxFocus}
              onBlur={vim.onBoxBlur}
              placeholder={placeholder}
              className="flex-1 min-w-0 h-full bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
            />
          </InputField>
          <div className="flex justify-end gap-2 mt-auto pt-3">
            <button
              type="button"
              onClick={onCancel}
              className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
            >
              {confirmLabel}
            </button>
          </div>
        </div>
        <HintBar>
          <Hint label={confirmLabel} keys={['Enter']} />
          {vim.mode === 'command' && <Hint label="Type" keys={vimKeyCaps(vimKeymap, 'insert-mode')} />}
          <Hint label={vim.mode === 'insert' ? 'Command mode' : 'Cancel'} keys={['Esc']} />
        </HintBar>
      </div>
    </DetachedWindow>
  )
}
