import { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { UpdateToastContent, type UpdateToastStatus } from './components/UpdateToastContent'
import './globals.css'

interface UpdateToastSpec {
  status: UpdateToastStatus
  theme?: string
  themeVariant?: string
}

function Popup(): JSX.Element | null {
  const [spec, setSpec] = useState<UpdateToastSpec | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onUpdateToastPopupSpec?.((next: UpdateToastSpec) => {
      setSpec(next)
      const root = document.documentElement
      if (next.theme) root.setAttribute('data-theme', next.theme)
      else root.removeAttribute('data-theme')
      if (next.themeVariant) root.setAttribute('data-theme-variant', next.themeVariant)
      else root.removeAttribute('data-theme-variant')
    })
    return cleanup
  }, [])

  const onClose = useCallback(() => {
    if (!spec) return
    window.electronAPI.updateToastPopupEvent?.({ type: 'dismiss', phase: spec.status.phase })
  }, [spec])

  const onInstall = useCallback(() => {
    window.electronAPI.installUpdate?.()
  }, [])

  const onMeasured = useCallback((size: { width: number; height: number }) => {
    window.electronAPI.updateToastPopupResize?.(size)
  }, [])

  if (!spec) return null
  return (
    <UpdateToastContent
      status={spec.status}
      onClose={onClose}
      onInstall={onInstall}
      onMeasured={onMeasured}
    />
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Popup />)
