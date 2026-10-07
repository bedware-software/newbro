// Right-hand column hosting an extension's chrome.sidePanel page. Main
// owns the page itself (a WebContentsView composited over this window —
// see main/extensions/side-panel.ts); this column reserves the space
// beside the tab, draws the header, and reports the placeholder rect —
// the same contract WebviewPanel has with tab views. The tab column
// shrinks by flex layout, so its own ResizeObserver re-bounds the page.

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

const MIN_WIDTH = 320
const DEFAULT_WIDTH = 400
const WIDTH_KEY = 'newbro-side-panel-width'
const ZERO = { x: 0, y: 0, width: 0, height: 0 }

interface ExtensionMeta {
  id: string
  name: string
  iconUrl?: string | null
}

function loadWidth(): number {
  const v = localStorage.getItem(WIDTH_KEY)
  const parsed = v ? parseInt(v, 10) : NaN
  return Number.isFinite(parsed) ? Math.max(MIN_WIDTH, parsed) : DEFAULT_WIDTH
}

/** `suppressed` hides the column without closing the panel (page
 *  fullscreen / cinema mode), mirroring the Bookshelf. */
export function SidePanel({ suppressed }: { suppressed: boolean }) {
  const [extensionId, setExtensionId] = useState<string | null>(null)
  const [meta, setMeta] = useState<ExtensionMeta | null>(null)
  const placeholderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.electronAPI
    api.getSidePanelState?.().then((s) => setExtensionId(s?.extensionId ?? null))
    return api.onSidePanelState?.((s) => setExtensionId(s.extensionId))
  }, [])

  useEffect(() => {
    if (!extensionId) {
      setMeta(null)
      return
    }
    let cancelled = false
    window.electronAPI.listExtensions?.().then((list) => {
      if (cancelled) return
      setMeta((list as ExtensionMeta[]).find((e) => e.id === extensionId) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [extensionId])

  const visible = !!extensionId && !suppressed

  // Report the placeholder rect while shown; park the view when hidden.
  // Also honours the 'newbro-tab-hide' / 'newbro-tab-show' events other
  // panels fire during drags — the native view would otherwise swallow
  // the pointer when the drag crosses it.
  useEffect(() => {
    const api = window.electronAPI
    if (!visible) {
      api.sidePanelSetBounds?.(ZERO)
      return
    }
    const el = placeholderRef.current
    if (!el) return
    let frame = 0
    let suppressedByDrag = false
    const report = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!el.isConnected || suppressedByDrag) return
        const rect = el.getBoundingClientRect()
        api.sidePanelSetBounds?.({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        })
      })
    }
    const hide = (): void => {
      suppressedByDrag = true
      api.sidePanelSetBounds?.(ZERO)
    }
    const show = (): void => {
      suppressedByDrag = false
      report()
    }
    report()
    const ro = new ResizeObserver(() => report())
    ro.observe(el)
    window.addEventListener('resize', report)
    window.addEventListener('newbro-tab-hide', hide)
    window.addEventListener('newbro-tab-show', show)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('newbro-tab-hide', hide)
      window.removeEventListener('newbro-tab-show', show)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [visible])

  // ── Resize ── (drag handle sits outside the placeholder, so the native
  // view never covers it; both views hide for the drag's duration)
  const [width, setWidth] = useState(loadWidth)
  const resizing = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const currentW = useRef(width)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = true
    startX.current = e.clientX
    startW.current = currentW.current
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.dispatchEvent(new CustomEvent('newbro-tab-hide'))
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!resizing.current) return
      const maxW = Math.floor(window.innerWidth / 2)
      const next = Math.min(maxW, Math.max(MIN_WIDTH, startW.current - (e.clientX - startX.current)))
      currentW.current = next
      setWidth(next)
    }
    const onUp = (): void => {
      if (!resizing.current) return
      resizing.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(WIDTH_KEY, String(currentW.current))
      window.dispatchEvent(new CustomEvent('newbro-tab-show'))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  if (!visible) return null

  return (
    <div style={{ width }} className="flex shrink-0 overflow-hidden border-l border-border bg-toolbar">
      <div
        className="w-1.5 shrink-0 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={onResizeStart}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-1.5 pr-2">
          {meta?.iconUrl && <img src={meta.iconUrl} alt="" className="h-4 w-4 shrink-0" />}
          <span className="flex-1 truncate text-sm font-medium text-foreground">{meta?.name ?? 'Side panel'}</span>
          <button
            aria-label="Close side panel"
            title="Close side panel"
            onClick={() => window.electronAPI.closeSidePanel?.()}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>
        {/* Must stay empty: main paints the panel's WebContentsView here. */}
        <div ref={placeholderRef} className="min-h-0 flex-1" />
      </div>
    </div>
  )
}
