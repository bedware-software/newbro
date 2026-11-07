import { useEffect, useRef } from 'react'
import type { VimMode } from '../lib/vim-mode'

interface Props {
  /** Vim's mode, null while Vim mode is off: the mark wears the mode's
   *  colours — COMMAND's (and so off's) blue and cyan, INSERT's green and
   *  teal — the trios the address bar's edge runs in. */
  mode: VimMode | null
  /** Bumped to glitch the mark once more (the Menu button on hover). */
  glitchKey?: number
}

/** The app's mark — two katanas crossed point-down into a V, the guards on
 *  top — in the toolbar's top-left, on the Menu button. A change of Vim's
 *  mode tears it into the new colours: three copies of it, the two behind
 *  in the other mode's and the third colour, cut into bands that jump
 *  sideways for half a second (.brand-mark in globals.css). Still for Reduce
 *  motion, and while the window isn't the one in use. */
export function BrandMark({ mode, glitchKey = 0 }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) { first.current = false; return }
    const el = ref.current
    if (!el || document.documentElement.hasAttribute('data-window-inactive')) return
    // Restart the animation even if the last burst is still running.
    el.removeAttribute('data-glitch')
    void el.offsetWidth
    el.setAttribute('data-glitch', '')
    const t = setTimeout(() => el.removeAttribute('data-glitch'), 600)
    return () => clearTimeout(t)
  }, [mode, glitchKey])

  return (
    <span ref={ref} className="brand-mark" data-mode={mode === 'insert' ? 'insert' : 'command'} aria-hidden="true">
      <Katanas />
      <Katanas />
      <Katanas />
    </span>
  )
}

function Katanas() {
  return (
    <svg viewBox="0 0 64 64">
      <polygon points="53.38,17.3 35.36,50.27 27.81,55.58 28.83,47.23 42.51,12.23" fill="var(--c1)" />
      <polygon points="10.62,17.3 28.64,50.27 36.19,55.58 35.17,47.23 21.49,12.23" fill="var(--c1)" />
      <path
        d="M6.39,16.51L7.15,13.4L20.74,7.06L23.61,8.49L22.85,11.6L9.26,17.94Z M57.61,16.51L56.85,13.4L43.26,7.06L40.39,8.49L41.15,11.6L54.74,17.94Z"
        fill="var(--c3)"
      />
    </svg>
  )
}
