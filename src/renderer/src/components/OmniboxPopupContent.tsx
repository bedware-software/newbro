// The rows of the address bar's suggestion popup (Chrome / Edge style): an
// icon, the page title or query with the typed words in bold, the URL, and
// an X to forget a history entry. Rendered in its own window — see
// omnibox-protocol.ts; the Toolbar owns selection and the keyboard.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Globe, History, Search, X } from 'lucide-react'
import type { OmniboxPopupEvent, OmniboxPopupRow, OmniboxPopupSpec } from './omnibox-protocol'

/** Bold every occurrence of the typed words, like Chrome's match
 *  classification. */
function highlight(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text
  const lower = text.toLowerCase()
  const marks = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    if (!term) continue
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      for (let i = at; i < at + term.length && i < text.length; i++) marks[i] = true
    }
  }
  const parts: ReactNode[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      const chunk = text.slice(start, i)
      parts.push(marks[start] ? <strong key={start} className="font-semibold">{chunk}</strong> : chunk)
      start = i
    }
  }
  return parts
}

function RowIcon({ row }: { row: OmniboxPopupRow }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [row.favicon])
  if (row.kind === 'search' || row.kind === 'suggest') return <Search size={15} className="shrink-0 text-muted-foreground" />
  if (row.kind === 'search-history') return <History size={15} className="shrink-0 text-muted-foreground" />
  if (row.favicon && !broken) {
    return <img src={row.favicon} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-sm" onError={() => setBroken(true)} />
  }
  return <Globe size={15} className="shrink-0 text-muted-foreground" />
}

export function OmniboxPopupContent({
  spec,
  onEvent,
  onMeasured,
}: {
  spec: OmniboxPopupSpec
  onEvent: (evt: OmniboxPopupEvent) => void
  onMeasured: (height: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = (): void => onMeasured(Math.ceil(el.getBoundingClientRect().height))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onMeasured, spec.rows.length])

  // A long list in a short window scrolls; keep the selection in view.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${spec.selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [spec.selected, spec.rows])

  return (
    <div
      ref={listRef}
      className="max-h-[calc(100vh-24px)] overflow-y-auto rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl"
      role="listbox"
    >
      {spec.rows.map((row, index) => {
        const selected = index === spec.selected
        const isUrl = row.kind === 'history' || row.kind === 'navigate'
        const title = isUrl ? row.description : row.contents
        return (
          <div
            key={index}
            data-row={index}
            role="option"
            aria-selected={selected}
            // mousedown, not click: a middle click has no click event, and
            // acting on press matches how the address bar list feels in Chrome.
            onMouseDown={(e) => {
              if (e.button !== 0 && e.button !== 1) return
              e.preventDefault()
              if ((e.target as HTMLElement).closest('[data-remove]')) return
              onEvent({
                type: 'click', index, button: e.button,
                ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
              })
            }}
            className={`group flex h-9 cursor-default items-center gap-3 px-3 text-sm ${
              selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
            }`}
          >
            <RowIcon row={row} />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
              {isUrl ? (
                title ? (
                  <>
                    <span className="truncate text-foreground">{highlight(title, spec.terms)}</span>
                    <span className="shrink-0 text-muted-foreground">–</span>
                    <span className="truncate text-primary">{highlight(row.contents, spec.terms)}</span>
                  </>
                ) : (
                  <span className="truncate text-foreground">{highlight(row.contents, spec.terms)}</span>
                )
              ) : (
                <>
                  <span className="truncate text-foreground">{highlight(title, spec.terms)}</span>
                  {row.description && (
                    <>
                      <span className="shrink-0 text-muted-foreground">–</span>
                      <span className="shrink-0 text-muted-foreground">{row.description}</span>
                    </>
                  )}
                </>
              )}
            </div>
            {row.removable && (
              <button
                data-remove
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (e.button === 0) onEvent({ type: 'remove', index })
                }}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${
                  selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title="Remove suggestion (Shift+Delete)"
                aria-label="Remove suggestion"
              >
                <X size={13} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
