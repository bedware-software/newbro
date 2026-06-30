import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { log } from '../lib/log'

const DRAG_HANDLE_SELECTOR = '[data-detached-drag-handle]'
const DRAG_CANCEL_SELECTOR = '[data-detached-no-drag]'
const DRAG_THRESHOLD_PX = 2

interface Props {
  open: boolean
  title: string
  width: number
  height: number
  resizable?: boolean
  closeOnEscape?: boolean
  // Close the popup when its window loses focus (e.g. user clicks back to the
  // parent window or another app). Armed only after the popup first gains
  // focus, so the show-sequence's transient blurs don't dismiss it.
  closeOnBlur?: boolean
  // Keep the popup floating above the app's windows (a modal-ish offer that
  // shouldn't get buried). Applied at reveal time.
  alwaysOnTop?: boolean
  /** When set, remember the popup's size + position across opens, keyed by
   *  this string. Saved to localStorage on resize, drag-end, and unmount.
   *  Saved bounds override the `width` / `height` props on subsequent
   *  opens — the props become "first-launch defaults". */
  persistKey?: string
  onClose: () => void
  onWindowChange?: (popup: Window | null) => void
  children: ReactNode
}

interface SavedBounds {
  width: number
  height: number
  left?: number
  top?: number
}

const PERSIST_MIN_W = 200
const PERSIST_MIN_H = 200

function readSavedBounds(key: string): SavedBounds | null {
  try {
    const raw = window.localStorage.getItem(`detached-bounds:${key}`)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SavedBounds>
    if (
      typeof v.width === 'number' && typeof v.height === 'number' &&
      v.width >= PERSIST_MIN_W && v.height >= PERSIST_MIN_H
    ) {
      return {
        width: v.width,
        height: v.height,
        left: typeof v.left === 'number' ? v.left : undefined,
        top: typeof v.top === 'number' ? v.top : undefined,
      }
    }
  } catch {
    /* corrupt entry — fall back to defaults */
  }
  return null
}

function writeSavedBounds(key: string, b: SavedBounds): void {
  try {
    window.localStorage.setItem(`detached-bounds:${key}`, JSON.stringify(b))
  } catch (err) {
    log.warn('detached-window: failed to persist bounds', { key, err: String(err) })
  }
}

function syncThemeToPopup(popupDoc: Document): void {
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme) popupDoc.documentElement.setAttribute('data-theme', theme)
  else popupDoc.documentElement.removeAttribute('data-theme')
  const variant = document.documentElement.getAttribute('data-theme-variant')
  if (variant) popupDoc.documentElement.setAttribute('data-theme-variant', variant)
  else popupDoc.documentElement.removeAttribute('data-theme-variant')
}

function copyStylesToPopup(popupDoc: Document): void {
  const nodes = document.querySelectorAll('style, link[rel="stylesheet"]')
  nodes.forEach((node) => {
    popupDoc.head.appendChild(node.cloneNode(true))
  })
}

export function DetachedWindow({
  open,
  title,
  width,
  height,
  resizable = true,
  closeOnEscape = true,
  closeOnBlur = false,
  alwaysOnTop = false,
  persistKey,
  onClose,
  onWindowChange,
  children,
}: Props) {
  const popupRef = useRef<Window | null>(null)
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)
  const suppressBeforeUnloadRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onWindowChangeRef = useRef(onWindowChange)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    onWindowChangeRef.current = onWindowChange
  }, [onWindowChange])

  useEffect(() => {
    if (!open) return

    // Saved bounds (if any) override the prop defaults. The width/height
    // props then act as first-launch fallbacks; once the user resizes /
    // moves, those values stick across opens via localStorage.
    const saved = persistKey ? readSavedBounds(persistKey) : null
    const finalWidth = saved?.width ?? width
    const finalHeight = saved?.height ?? height
    const left = saved?.left ?? Math.max(0, window.screenX + Math.round((window.outerWidth - finalWidth) / 2))
    const top = saved?.top ?? Math.max(0, window.screenY + Math.round((window.outerHeight - finalHeight) / 2))

    const popup = window.open(
      '',
      '',
      [
        'popup=yes',
        `left=${left}`,
        `top=${top}`,
        `width=${finalWidth}`,
        `height=${finalHeight}`,
        `resizable=${resizable ? 'yes' : 'no'}`,
        'scrollbars=no',
        'toolbar=no',
        'location=no',
        'status=no',
        'menubar=no',
      ].join(','),
    )

    if (!popup) {
      // window.open returning null usually means setWindowOpenHandler in
      // main rejected the request (URL mismatch) or the popup blocker
      // tripped. Either case is a silent failure for the user — no dialog
      // appears, no console error. Log it so the userData/newbro.log file
      // shows the failure when the user reports "the dialog didn't open".
      log.warn('detached-window: window.open returned null', { title })
      return
    }

    popupRef.current = popup
    onWindowChangeRef.current?.(popup)

    popup.document.title = title
    popup.document.body.innerHTML = ''
    popup.document.body.style.margin = '0'
    popup.document.body.style.height = '100vh'
    popup.document.body.style.overflow = 'hidden'

    syncThemeToPopup(popup.document)
    copyStylesToPopup(popup.document)

    const root = popup.document.createElement('div')
    root.style.height = '100%'
    root.style.width = '100%'
    popup.document.body.appendChild(root)
    setContainerEl(root)

    const handleBeforeUnload = () => {
      if (!suppressBeforeUnloadRef.current) onCloseRef.current()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') onCloseRef.current()
      // F12 / Ctrl+Shift+I opens DevTools for THIS popup (it's its own window,
      // so the main "Toggle UI Developer Tools" can't reach it). getFocusedWindow
      // in main resolves to this popup since it has focus.
      else if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'i'))) {
        e.preventDefault()
        window.electronAPI.toggleFocusedDevTools?.()
      }
    }

    // Drag is driven by the main process — it's the only coordinate space
    // that's consistent on Windows with non-100% DPI. On mousedown we tell
    // main to snapshot the popup's bounds + cursor; on mousemove we tell it
    // to reposition. See src/main/ipc.ts for why we can't use popup.moveTo /
    // setPosition and why width/height must be captured once.
    // Debounced bounds persistence. Resize fires many events per drag of an
    // edge; we coalesce them into one localStorage write per quiet window.
    let persistTimer: ReturnType<typeof setTimeout> | null = null
    const captureBoundsNow = () => {
      if (!persistKey || popup.closed) return
      writeSavedBounds(persistKey, {
        width: popup.outerWidth,
        height: popup.outerHeight,
        left: popup.screenX,
        top: popup.screenY,
      })
    }
    const schedulePersist = () => {
      if (!persistKey) return
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(captureBoundsNow, 200)
    }

    const handleResize = () => schedulePersist()
    if (persistKey) popup.addEventListener('resize', handleResize)

    let dragState: {
      startScreenX: number
      startScreenY: number
      moved: boolean
    } | null = null
    let rafPending = false

    const stopDragging = () => {
      const wasDragging = !!dragState && dragState.moved
      if (dragState) {
        window.electronAPI.detachedWindowDragEnd()
      }
      dragState = null
      rafPending = false
      popup.document.body.style.userSelect = ''
      popup.document.body.style.cursor = ''
      if (wasDragging) schedulePersist()
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as Element | null
      if (!target) return
      if (target.closest(DRAG_CANCEL_SELECTOR)) return
      if (!target.closest(DRAG_HANDLE_SELECTOR)) return
      const startScreenX = e.screenX
      const startScreenY = e.screenY
      window.electronAPI.detachedWindowDragStart().then((ok) => {
        // Ignore if the drag was already stopped (e.g. mouseup before IPC resolved).
        if (!ok) return
        dragState = { startScreenX, startScreenY, moved: false }
      })
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState) return
      const dx = e.screenX - dragState.startScreenX
      const dy = e.screenY - dragState.startScreenY
      if (!dragState.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
        return
      }
      dragState.moved = true
      popup.document.body.style.userSelect = 'none'
      popup.document.body.style.cursor = 'move'
      // Coalesce updates with rAF so we send at most one IPC per paint. The
      // main process reads the live cursor itself, so we don't need to pass
      // anything — the latest cursor position is always correct.
      if (!rafPending) {
        rafPending = true
        popup.requestAnimationFrame(() => {
          rafPending = false
          if (dragState) window.electronAPI.detachedWindowDragUpdate()
        })
      }
      e.preventDefault()
    }

    const themeObserver = new MutationObserver(() => syncThemeToPopup(popup.document))
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-variant'],
    })

    let closeOnBlurArmed = false
    const handleFocus = () => { closeOnBlurArmed = true }
    const handleBlurClose = () => {
      if (closeOnBlur && closeOnBlurArmed) onCloseRef.current()
    }

    popup.addEventListener('beforeunload', handleBeforeUnload)
    popup.addEventListener('keydown', handleKeyDown)
    popup.document.addEventListener('mousedown', handleMouseDown)
    popup.document.addEventListener('mousemove', handleMouseMove)
    popup.document.addEventListener('mouseup', stopDragging)
    popup.addEventListener('blur', stopDragging)
    popup.addEventListener('focus', handleFocus)
    popup.addEventListener('blur', handleBlurClose)

    return () => {
      themeObserver.disconnect()
      popup.removeEventListener('beforeunload', handleBeforeUnload)
      popup.removeEventListener('keydown', handleKeyDown)
      popup.document.removeEventListener('mousedown', handleMouseDown)
      popup.document.removeEventListener('mousemove', handleMouseMove)
      popup.document.removeEventListener('mouseup', stopDragging)
      popup.removeEventListener('blur', stopDragging)
      popup.removeEventListener('focus', handleFocus)
      popup.removeEventListener('blur', handleBlurClose)
      if (persistKey) popup.removeEventListener('resize', handleResize)
      // Flush any pending persist + capture one last set of bounds so a
      // resize-then-close right after each other still saves the new size.
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
      captureBoundsNow()
      stopDragging()
      onWindowChangeRef.current?.(null)
      setContainerEl(null)
      popupRef.current = null
      if (!popup.closed) {
        suppressBeforeUnloadRef.current = true
        popup.close()
        suppressBeforeUnloadRef.current = false
      }
    }
  }, [open, width, height, resizable, closeOnEscape, closeOnBlur, persistKey])

  // Show the popup window once React has rendered content into the portal.
  // Double-rAF ensures the browser has committed the paint before we reveal.
  useEffect(() => {
    if (!containerEl) return
    const popup = popupRef.current
    if (!popup || popup.closed) return
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ;(window as any).electronAPI?.detachedWindowShow(alwaysOnTop)
      })
    })
    return () => cancelAnimationFrame(id)
  }, [containerEl, alwaysOnTop])

  useEffect(() => {
    const popup = popupRef.current
    if (!popup || popup.closed) return
    popup.document.title = title
  }, [title])

  if (!open || !containerEl) return null

  return createPortal(children, containerEl)
}
