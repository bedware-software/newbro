import { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { DropdownMenuContent } from './components/DropdownMenuContent'
import type { DropdownEventBody, DropdownSpec } from './components/dropdown-protocol'
import './globals.css'

// Popup window entry. Lifecycle:
// 1. Main creates this window (transparent, frameless, always-on-top child).
// 2. Main sends a `dropdown:popup-spec` IPC with the spec; we render.
// 3. We measure the menu content and send `dropdown:popup-resize` so main
//    snaps the window to a snug size.
// 4. User interactions emit DropdownEvents via `dropdown:popup-event`.
// 5. Main hides the window on terminal events; we keep the spec around so
//    a quick re-open doesn't flash empty content.
function Popup() {
  const [spec, setSpec] = useState<DropdownSpec | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onDropdownPopupSpec?.((next: DropdownSpec) => {
      setSpec(next)
      // Mirror parent theme on the popup's <html>; CSS uses these attrs.
      const root = document.documentElement
      if (next.theme) root.setAttribute('data-theme', next.theme)
      else root.removeAttribute('data-theme')
      if (next.themeVariant) root.setAttribute('data-theme-variant', next.themeVariant)
      else root.removeAttribute('data-theme-variant')
    })
    return cleanup
  }, [])

  const onEmit = useCallback((evt: DropdownEventBody) => {
    window.electronAPI.dropdownPopupEvent?.(evt)
  }, [])

  const onMeasured = useCallback((size: { width: number; height: number }) => {
    window.electronAPI.dropdownPopupResize?.(size)
  }, [])

  if (!spec) return null
  return <DropdownMenuContent spec={spec} onEmit={onEmit} onMeasured={onMeasured} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Popup />)
