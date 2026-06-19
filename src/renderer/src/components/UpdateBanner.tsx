import { useEffect, useRef, useState, type RefObject } from 'react'
import type { UpdateToastStatus } from './UpdateToastContent'

type UpdateStatus =
  | { phase: 'idle' }
  | UpdateToastStatus
  | { phase: 'unsupported' }

interface ToastTargetRect {
  x: number
  y: number
  width: number
  height: number
}

interface ThemeAttrs {
  theme?: string
  themeVariant?: string
}

function readThemeAttrs(): ThemeAttrs {
  const root = document.documentElement
  return {
    theme: root.getAttribute('data-theme') ?? undefined,
    themeVariant: root.getAttribute('data-theme-variant') ?? undefined,
  }
}

function isToastStatus(status: UpdateStatus): status is UpdateToastStatus {
  return (
    status.phase === 'checking' ||
    status.phase === 'not-available' ||
    status.phase === 'available' ||
    status.phase === 'downloading' ||
    status.phase === 'downloaded' ||
    status.phase === 'error'
  )
}

/**
 * Update notification controller.
 *
 * The actual toast is rendered in a separate transparent child BrowserWindow.
 * Tabs are native WebContentsViews and composite above this renderer, so a DOM
 * overlay would be hidden; the previous in-flow workaround made the site
 * viewport shorter. This component now only observes updater state and sends
 * show/hide commands to the popup window.
 */
export function UpdateBanner({
  targetRef,
  disabled = false,
}: {
  targetRef: RefObject<HTMLElement>
  disabled?: boolean
}): null {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [targetRect, setTargetRect] = useState<ToastTargetRect | null>(null)
  const [themeAttrs, setThemeAttrs] = useState<ThemeAttrs>(() => readThemeAttrs())
  const initialStatusRef = useRef<UpdateStatus | null>(null)

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api) return

    api.getUpdaterStatus?.().then((s: UpdateStatus) => {
      initialStatusRef.current = s ?? { phase: 'idle' }
      if (s) setStatus(s)
    })

    const cleanup = api.onUpdaterStatus?.((s: UpdateStatus) => {
      setStatus(s)
    })
    return cleanup
  }, [])

  useEffect(() => {
    const api = (window as any).electronAPI
    const cleanup = api?.onUpdateToastEvent?.((evt: { type?: string; phase?: string }) => {
      if (evt?.type === 'dismiss' && evt.phase) setDismissed(evt.phase)
    })
    return cleanup
  }, [])

  useEffect(() => {
    const el = targetRef.current
    if (!el) return
    let frame = 0
    const report = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!el.isConnected) return
        const rect = el.getBoundingClientRect()
        setTargetRect({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        })
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [targetRef])

  useEffect(() => {
    const update = (): void => setThemeAttrs(readThemeAttrs())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-variant'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setDismissed((prev) => (prev === status.phase ? prev : null))
  }, [status.phase])

  useEffect(() => {
    if (status.phase !== 'not-available') return
    const id = setTimeout(() => setDismissed('not-available'), 4000)
    return () => clearTimeout(id)
  }, [status.phase])

  const isStaleInitial =
    initialStatusRef.current?.phase === status.phase &&
    (status.phase === 'not-available' || status.phase === 'idle')

  const visible =
    !disabled &&
    !isStaleInitial &&
    isToastStatus(status) &&
    dismissed !== status.phase &&
    targetRect !== null

  useEffect(() => {
    const api = (window as any).electronAPI
    if (!api?.showUpdateToast || !api?.hideUpdateToast) return

    if (!visible || !isToastStatus(status) || !targetRect) {
      api.hideUpdateToast()
      return
    }

    api.showUpdateToast({
      status,
      targetRect,
      ...themeAttrs,
    })
  }, [visible, status, targetRect, themeAttrs])

  useEffect(() => {
    return () => { (window as any).electronAPI?.hideUpdateToast?.() }
  }, [])

  return null
}
