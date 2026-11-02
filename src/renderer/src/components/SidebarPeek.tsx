import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Sidebar, getSidebarWidth } from './Sidebar'
import { copyStylesToPopup, pageBackgroundHex, syncThemeToPopup } from './DetachedWindow'
import type { VimKeymap } from '../lib/vim-keymap'
import { log } from '../lib/log'

// The Sidebar over the page while it's hidden (Settings → Keyboard Shortcuts
// → Hide the Sidebar): holding Ctrl in Vim's COMMAND mode brings it up, over
// the page's left edge, with the page left where it is — no reflow. A tab's
// page is a native view drawn above this window's own DOM, so the Sidebar
// can't simply lie over it here: it goes in a small window of its own pinned
// there — opened from this renderer, so it's this Sidebar, portaled in —
// kept open while the setting is on, shown and hidden by main without ever
// taking the keyboard.

/** Mirrored in src/main/ipc.ts: a pinned popup with this id prefix is a peek. */
const PEEK_ID_PREFIX = 'peek-'
// Clear of the window's edges, so it reads as lying over the page.
const PEEK_INSET = 6

interface Props {
  /** Keeps the peek window open (Vim mode on, the Sidebar hidden). */
  enabled: boolean
  /** Shows it: the Sidebar keys are live (Ctrl held). */
  shown: boolean
  /** The area under the toolbar — the peek is as tall as it is. */
  anchorRef: RefObject<HTMLElement | null>
  showTabNumbers: boolean
  vimKeymap: VimKeymap | null
}

export function SidebarPeek({ enabled, shown, anchorRef, showTabNumbers, vimKeymap }: Props) {
  const [popup, setPopup] = useState<{ id: string; root: HTMLDivElement } | null>(null)
  // Its top-left corner in this window's content area: the Sidebar's menus
  // open in those coordinates.
  const [corner, setCorner] = useState({ x: 0, y: 0 })

  useEffect(() => {
    if (!enabled) return
    const id = `${PEEK_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const background = pageBackgroundHex()
    const win = window.open(
      '',
      '',
      [
        'popup=yes',
        `left=${window.screenX}`,
        `top=${window.screenY}`,
        `width=${getSidebarWidth()}`,
        'height=400',
        'resizable=no',
        'scrollbars=no',
        'toolbar=no',
        'location=no',
        'status=no',
        'menubar=no',
        `newbro-popup-id=${id}`,
        ...(background ? [`newbro-bg=${background}`] : []),
      ].join(','),
    )
    if (!win) {
      log.warn('sidebar-peek: window.open returned null')
      return
    }
    win.document.title = 'Sidebar'
    win.document.body.innerHTML = ''
    win.document.body.style.margin = '0'
    win.document.body.style.height = '100vh'
    win.document.body.style.overflow = 'hidden'
    syncThemeToPopup(win.document)
    copyStylesToPopup(win.document)
    const root = win.document.createElement('div')
    root.style.height = '100%'
    win.document.body.appendChild(root)
    setPopup({ id, root })

    const themeObserver = new MutationObserver(() => syncThemeToPopup(win.document))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-variant'] })
    return () => {
      themeObserver.disconnect()
      setPopup(null)
      win.close()
    }
  }, [enabled])

  // Where it sits and whether it shows; again whenever the area changes size.
  const id = popup?.id ?? null
  useEffect(() => {
    const anchor = anchorRef.current
    if (!id || !anchor) return
    const place = (): void => {
      const r = anchor.getBoundingClientRect()
      const left = Math.round(r.left + PEEK_INSET)
      const top = Math.round(r.top + PEEK_INSET)
      setCorner((c) => (c.x === left && c.y === top ? c : { x: left, y: top }))
      window.electronAPI.sidebarPeekSet?.(id, {
        left,
        top,
        width: getSidebarWidth(),
        height: Math.max(0, Math.round(r.height - 2 * PEEK_INSET)),
        shown,
      })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(anchor)
    return () => ro.disconnect()
  }, [id, shown, anchorRef])

  if (!popup) return null
  return createPortal(
    <div className="h-full flex rounded-lg border border-border overflow-hidden bg-toolbar">
      <Sidebar
        visible
        peek={corner}
        showTabNumbers={showTabNumbers}
        vimActive={shown}
        vimKeymap={vimKeymap}
      />
    </div>,
    popup.root,
  )
}
