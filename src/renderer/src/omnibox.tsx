import { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { OmniboxPopupContent } from './components/OmniboxPopupContent'
import type { OmniboxPopupEvent, OmniboxPopupSpec } from './components/omnibox-protocol'
import './globals.css'

// Address-bar suggestion popup entry (src/main/omnibox-popup.ts). Main
// forwards the Toolbar's spec on every change; we render it, report our
// height so main can size the window, and send clicks back. The window
// never has keyboard focus — the address bar handles every key.
function Popup() {
  const [spec, setSpec] = useState<OmniboxPopupSpec | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onOmniboxPopupSpec?.((next) => {
      const s = next as OmniboxPopupSpec
      setSpec(s)
      const root = document.documentElement
      if (s.theme) root.setAttribute('data-theme', s.theme)
      else root.removeAttribute('data-theme')
      if (s.themeVariant) root.setAttribute('data-theme-variant', s.themeVariant)
      else root.removeAttribute('data-theme-variant')
      if (s.density) root.setAttribute('data-density', s.density)
      else root.removeAttribute('data-density')
    })
    return cleanup
  }, [])

  const onEvent = useCallback((evt: OmniboxPopupEvent) => {
    window.electronAPI.omniboxPopupEvent?.(evt)
  }, [])

  const onMeasured = useCallback((height: number) => {
    window.electronAPI.omniboxPopupResize?.({ height })
  }, [])

  if (!spec) return null
  return <OmniboxPopupContent spec={spec} onEvent={onEvent} onMeasured={onMeasured} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Popup />)
