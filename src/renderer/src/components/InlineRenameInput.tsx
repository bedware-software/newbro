import { useEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  /** Enter, or a real click-away inside our own window. */
  onCommit: () => void
  /** Escape. */
  onCancel: () => void
  className?: string
}

/** The inline rename field used by every "click the name and type" spot —
 *  sidebar tab groups, bookshelf readings, bookshelf groups.
 *
 *  It exists as one component because getting the caret to actually land in
 *  it is fiddly. Renames are usually started from a context menu, and our
 *  menus live in their own popup `BrowserWindow` (see main/dropdown-window.ts).
 *  When the chosen action reaches this renderer the popup is still the OS
 *  focus owner or is only just hiding — and once it hides, focus returns to
 *  the *window*, where the active tab's `WebContentsView` usually claims it.
 *  React's `autoFocus` only sets DOM focus inside our own webContents, so the
 *  field would render caret-less until the user clicked it.
 *
 *  The fix is the same two-step trick the URL bar uses (lib/focus-url-bar.ts):
 *  ask main to pull OS keyboard focus back to the renderer, then focus the
 *  input — retried, because the popup's hide can land after our first attempt
 *  and knock focus straight back out. */
export function InlineRenameInput({ value, onChange, onCommit, onCancel, className }: Props) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.electronAPI?.focusWindowRenderer?.()
    const attempt = (): void => {
      const el = ref.current
      if (!el) return
      // Our webContents isn't the OS focus owner yet (popup still up, or the
      // window handed focus to the tab view). Focusing now would only set DOM
      // focus with no caret, so re-ask main and let a later pass — or the
      // window 'focus' listener below — do the real work.
      if (!document.hasFocus()) {
        window.electronAPI?.focusWindowRenderer?.()
        return
      }
      if (document.activeElement === el) return
      el.focus()
      // Caret at the end rather than a select-all: renames usually tweak an
      // existing name, and Cmd/Ctrl+A still replaces the whole thing.
      const end = el.value.length
      try { el.setSelectionRange(end, end) }
      catch (err) { console.warn('InlineRenameInput: setSelectionRange threw:', err) }
    }
    // Fires when OS focus finally lands on this renderer — covers the popup
    // handoff being slower than our timers, and the user switching apps
    // mid-rename and coming back.
    window.addEventListener('focus', attempt)
    const timers = [0, 60, 180].map((delay) => setTimeout(attempt, delay))
    return () => {
      window.removeEventListener('focus', attempt)
      for (const t of timers) clearTimeout(t)
    }
  }, [])

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit()
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        // Window-level focus loss (the context-menu popup hiding, or the user
        // switching apps) also fires blur here. Committing on those would end
        // the rename before the caret ever lands — only a real click-away
        // inside our own window counts; the focus pass above re-grabs the
        // input when focus comes back.
        if (document.hasFocus()) onCommit()
      }}
      // The rows underneath treat clicks as select / collapse-toggle.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className={className}
    />
  )
}
