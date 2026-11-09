// The address bar. On a web page it's the address, edited in place as
// Chrome's / Edge's omnibox is (e, a click, Cmd/Ctrl+L, a new tab), with
// their suggestions (lib/use-address-suggestions.ts): history, past
// searches, the engine's, inline completion; Enter opens, Alt/Shift+Enter in
// a new tab, Cmd+Enter in the background, Ctrl+Enter turns a word into
// www.<word>.com. Esc first returns to what was typed, then to the page's
// address, then hands the keyboard back to the page. The address editor
// (E, components/UrlEditor.tsx) is the address block by block.
//
// On a page this window draws (the group page, Search Everything, the keys,
// the Bookshelf, Downloads, Bangs) it's the page's filter instead
// (lib/address-filter.ts): the page's name in a chip, what's typed filtering
// its rows.

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { setAddressQuery, useAddressFilterStore, type AddressFilterSpec } from '../lib/address-filter'
import { useAddressSuggestions, type Disposition } from '../lib/use-address-suggestions'
import { openAddress } from '../lib/open-address'

interface Props {
  tabId: string | null
  tabUrl: string
  /** The bar's box: the suggestion list opens under it, as wide as it. */
  anchorRef: React.RefObject<HTMLDivElement | null>
}

/** Enter's modifiers, as the address bar's: Shift or Alt a tab in front,
 *  Cmd one behind. */
function dispositionOf(e: { shiftKey: boolean; altKey: boolean; metaKey: boolean }): Disposition {
  if (e.metaKey) return 'background-tab'
  if (e.shiftKey || e.altKey) return 'foreground-tab'
  return 'current'
}

export function Omnibox(props: Props) {
  const spec = useAddressFilterStore((s) => s.spec)
  return spec ? <FilterBox spec={spec} /> : <AddressBox {...props} />
}

function AddressBox({ tabId, tabUrl, anchorRef }: Props) {
  const shown = tabUrl === 'about:blank' ? '' : tabUrl
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(shown)
  const [focused, setFocused] = useState(false)
  /** The first click into the bar selects the whole address (Chrome's). */
  const selectAllOnMouseUpRef = useRef(false)

  const sugg = useAddressSuggestions({
    inputRef,
    tabId,
    tabUrl: shown,
    blankTab: !shown,
    enabled: focused,
    onText: setValue,
    getAnchor: () => {
      const r = anchorRef.current?.getBoundingClientRect()
      return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
    },
    onNavigated: () => inputRef.current?.blur(),
  })
  const suggRef = useRef(sugg)
  suggRef.current = sugg

  /** Back to the page's address, the edit and the list dropped. */
  const revert = (selectAll: boolean): void => {
    suggRef.current.reset()
    setValue(shown)
    const input = inputRef.current
    if (!input) return
    input.value = shown
    if (selectAll && input.ownerDocument.activeElement === input) input.select()
  }

  // Follow the page's address while nothing's typed (Chrome updates a
  // focused but untouched omnibox too); a full selection survives it — a new
  // tab's focus selects it, and the page settling on its URL mustn't drop
  // that.
  useEffect(() => {
    if (suggRef.current.editing()) return
    const input = inputRef.current
    const hadAll = !!input && document.activeElement === input && input.value.length > 0 &&
      input.selectionStart === 0 && input.selectionEnd === input.value.length
    setValue(shown)
    if (input) {
      input.value = shown
      if (hadAll) input.select()
    }
  }, [shown])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      sugg.commit(dispositionOf(e), e.ctrlKey)
      return
    }
    if (e.key === 'Escape') {
      // 1st: back to what was typed, the list closing.
      if (sugg.escape()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // 2nd: the page's address again, selected.
      if (sugg.editing() || value !== shown) {
        e.preventDefault()
        e.stopPropagation()
        revert(true)
      }
      // 3rd: the window's Esc gives the page the keyboard (COMMAND).
      return
    }
    if (sugg.handleKey(e)) e.preventDefault()
  }

  return (
    <input
      id="url-bar"
      ref={inputRef}
      type="text"
      value={value}
      role="combobox"
      aria-autocomplete="both"
      aria-expanded={sugg.popupOpen}
      // onInput, not onChange: see useAddressSuggestions.
      onInput={sugg.handleInput}
      onChange={() => {}}
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true)
        window.electronAPI.omniboxPrewarm?.()
      }}
      onMouseDown={(e) => {
        selectAllOnMouseUpRef.current = document.activeElement !== e.currentTarget
      }}
      onMouseUp={(e) => {
        if (!selectAllOnMouseUpRef.current) return
        selectAllOnMouseUpRef.current = false
        const input = e.currentTarget
        if (input.selectionStart === input.selectionEnd) {
          e.preventDefault()
          input.select()
        }
      }}
      onBlur={(e) => {
        // A blurred input keeps a dimmed selection; collapse it so the bar
        // reads as plain text again.
        try { e.currentTarget.setSelectionRange(0, 0) } catch { /* nothing selected */ }
        selectAllOnMouseUpRef.current = false
        setFocused(false)
        // Leaving drops the edit and the list: the page's address again.
        if (sugg.editing() || sugg.popupOpen || value !== shown) revert(false)
      }}
      placeholder="Enter URL or search..."
      spellCheck={false}
      autoComplete="off"
      className="flex-1 min-w-0 h-full px-2.5 bg-transparent border-none text-sm text-foreground outline-none placeholder:text-muted-foreground"
    />
  )
}

/** The bar as the page's filter: its name in a chip, then the box. */
function FilterBox({ spec }: { spec: AddressFilterSpec }) {
  const query = useAddressFilterStore((s) => s.query)
  const inputRef = useRef<HTMLInputElement>(null)

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      if (spec.onEnter?.(e)) {
        inputRef.current?.blur()
        return
      }
      // Nothing of the page's to open: what's typed is an address.
      if (query.trim() && openAddress(query, e.shiftKey || e.altKey || e.metaKey, 'address-filter')) {
        setAddressQuery('')
        inputRef.current?.blur()
      }
      return
    }
    if (e.key === 'Escape') {
      // COMMAND, the filter kept: the rows it left wear their labels.
      e.preventDefault()
      e.stopPropagation()
      inputRef.current?.blur()
      return
    }
    if (spec.onKey?.(e)) e.preventDefault()
  }

  return (
    <div className="flex-1 min-w-0 h-full flex items-center">
      {spec.color ? (
        <span
          data-group-container=""
          style={{ ['--gc' as string]: spec.color }}
          className="ml-1.5 flex shrink-0 max-w-48"
        >
          <span data-group-pill="" className="truncate rounded-md px-2 py-0.5 text-xs font-semibold">
            {spec.label || 'Unnamed group'}
          </span>
        </span>
      ) : (
        <span className="ml-1.5 flex shrink-0 max-w-48 items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">
          <Search size={11} className="shrink-0 opacity-70" />
          <span className="truncate">{spec.label}</span>
        </span>
      )}
      <input
        id="url-bar"
        ref={inputRef}
        type="text"
        value={query}
        data-address-filter=""
        onChange={(e) => setAddressQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={spec.placeholder}
        spellCheck={false}
        autoComplete="off"
        className="flex-1 min-w-0 h-full px-2.5 bg-transparent border-none text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  )
}
