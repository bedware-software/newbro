import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
  onClose: () => void
  onWindowChange?: (popup: Window | null) => void
  children: ReactNode
}

function syncThemeToPopup(popupDoc: Document): void {
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme) popupDoc.documentElement.setAttribute('data-theme', theme)
  else popupDoc.documentElement.removeAttribute('data-theme')
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

    const left = Math.max(0, window.screenX + Math.round((window.outerWidth - width) / 2))
    const top = Math.max(0, window.screenY + Math.round((window.outerHeight - height) / 2))

    const popup = window.open(
      '',
      '',
      [
        'popup=yes',
        `left=${left}`,
        `top=${top}`,
        `width=${width}`,
        `height=${height}`,
        `resizable=${resizable ? 'yes' : 'no'}`,
        'scrollbars=no',
        'toolbar=no',
        'location=no',
        'status=no',
        'menubar=no',
      ].join(','),
    )

    if (!popup) {
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
    }

    // Drag is fully driven by the main process: on mousedown we ask it to
    // snapshot the popup's position and the cursor screen point, and on each
    // mousemove we ask it to reposition the popup relative to those anchors.
    // We don't use `popup.screenX` / `popup.moveTo()` — on Windows with DPI
    // scaling those mix coordinate spaces and cause the window to grow while
    // dragging. `screen.getCursorScreenPoint()` + `BrowserWindow.setPosition()`
    // in main stay in DIP coordinates end-to-end.
    let dragState: {
      startScreenX: number
      startScreenY: number
      moved: boolean
    } | null = null

    const stopDragging = () => {
      if (dragState) {
        window.electronAPI.detachedWindowDragEnd()
      }
      dragState = null
      popup.document.body.style.userSelect = ''
      popup.document.body.style.cursor = ''
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
      window.electronAPI.detachedWindowDragUpdate()
      e.preventDefault()
    }

    const themeObserver = new MutationObserver(() => syncThemeToPopup(popup.document))
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    popup.addEventListener('beforeunload', handleBeforeUnload)
    popup.addEventListener('keydown', handleKeyDown)
    popup.document.addEventListener('mousedown', handleMouseDown)
    popup.document.addEventListener('mousemove', handleMouseMove)
    popup.document.addEventListener('mouseup', stopDragging)
    popup.addEventListener('blur', stopDragging)

    return () => {
      themeObserver.disconnect()
      popup.removeEventListener('beforeunload', handleBeforeUnload)
      popup.removeEventListener('keydown', handleKeyDown)
      popup.document.removeEventListener('mousedown', handleMouseDown)
      popup.document.removeEventListener('mousemove', handleMouseMove)
      popup.document.removeEventListener('mouseup', stopDragging)
      popup.removeEventListener('blur', stopDragging)
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
  }, [open, width, height, resizable, closeOnEscape])

  useEffect(() => {
    const popup = popupRef.current
    if (!popup || popup.closed) return
    popup.document.title = title
  }, [title])

  if (!open || !containerEl) return null

  return createPortal(children, containerEl)
}
