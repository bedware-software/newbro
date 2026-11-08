// The labels Vim's ; puts on the browser's own controls (lib/chrome-hints.ts),
// drawn over them: in the window, and in each opted-in popup's own
// document. Mounted once, by App; idle until ; is typed.

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { RowHint } from './KeyHints'
import { useHintLabels, useHintTargets, type HintTarget } from '../lib/hint-labels'
import {
  activateChromeHint,
  cancelChromeHints,
  collectChromeHintTargets,
  useChromeHintsActive,
  type ChromeHintTarget,
} from '../lib/chrome-hints'
import { useAppStore } from '../store/app-store'
import { log } from '../lib/log'
import type { VimMode } from '../lib/vim-mode'

// RowHint's cap is 18 px tall.
const CAP_HEIGHT = 18

export function ChromeHintsOverlay({ mode, pending }: {
  /** Vim mode's mode: anything but COMMAND puts the labels away. */
  mode: VimMode | null
  /** Keys typed so far: the part of a label typed lights up. */
  pending: string
}) {
  const active = useChromeHintsActive()
  const [found, setFound] = useState<ChromeHintTarget[] | null>(null)

  // Found as ; comes up, before the frame is painted, so the labels and the
  // keymap that types them arrive together.
  useLayoutEffect(() => {
    if (!active) {
      setFound(null)
      return
    }
    const targets = collectChromeHintTargets()
    log.event('chrome-hints: labelled', targets.length)
    if (targets.length === 0) {
      cancelChromeHints('nothing to label')
      return
    }
    setFound(targets)
  }, [active])

  const hintTargets = useMemo<HintTarget[] | null>(
    () => found?.map((t) => ({ id: t.id, activate: () => activateChromeHint(t) })) ?? null,
    [found],
  )
  useHintTargets('chrome-hints', 0, hintTargets, true)
  const labels = useHintLabels()

  // Out of COMMAND, the labels go: their keys would be typed instead.
  useEffect(() => {
    if (active && mode !== 'command') cancelChromeHints('left COMMAND')
  }, [active, mode])

  // Whatever moves what they stand over takes them away: a click, the
  // wheel, the window changing size or going to the background, another tab.
  useEffect(() => {
    if (!active) return
    const onPointer = (): void => cancelChromeHints('mouse')
    const onResize = (): void => cancelChromeHints('resize')
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('wheel', onPointer, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    const offActive = window.electronAPI.onWindowActive?.((windowActive) => {
      if (!windowActive) cancelChromeHints('window inactive')
    })
    const offStore = useAppStore.subscribe((state, prev) => {
      if (state.activeTabId !== prev.activeTabId || state.activeTabGroupId !== prev.activeTabGroupId) cancelChromeHints('tab changed')
    })
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('wheel', onPointer, true)
      window.removeEventListener('resize', onResize)
      offActive?.()
      offStore()
    }
  }, [active])

  if (!active || !found) return null

  // One layer per document the targets are in.
  const layers = new Map<Document, ChromeHintTarget[]>()
  for (const target of found) {
    const doc = target.popup ? target.popup.win.document : document
    if (target.popup?.win.closed) continue
    const list = layers.get(doc)
    if (list) list.push(target)
    else layers.set(doc, [target])
  }

  return (
    <>
      {[...layers].map(([doc, targets], i) => createPortal(
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[2147483647]">
          {targets.map((t) => {
            const label = labels.get(t.id)
            if (!label) return null
            const view = doc.defaultView
            const maxTop = (view?.innerHeight ?? window.innerHeight) - CAP_HEIGHT
            // At the control's left edge, halfway down it — over a row's
            // icon, beside a button's — and never off screen.
            const top = Math.max(0, Math.min(maxTop, t.rect.top + (t.rect.height - CAP_HEIGHT) / 2))
            const left = Math.max(0, t.rect.left)
            return (
              <div key={t.id} className="absolute" style={{ left, top }}>
                <RowHint mode="command" label={label} number={0} pending={pending} className="ring-1 ring-primary/60" />
              </div>
            )
          })}
        </div>,
        doc.body,
        `chrome-hints-${i}`,
      ))}
    </>
  )
}
