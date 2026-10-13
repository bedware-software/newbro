// The address editor (Vim's e): the active tab's address in a big box, cut
// into blocks — protocol, domain, each path level, parameters, fragment —
// labelled underneath with the key that names each one. In COMMAND mode an
// intent and a block's key act on that block: c changes it (selects it to
// type over), r removes it, y copies it, p pastes over it; y and p alone
// act on the whole address. u goes up a level, t keeps only the site,
// n copies the page's title; i / A / I / C go to typing. Enter goes there.
// A pinned popup over the top of the page area; while it's up the toolbar
// shows workspace stats where the address bar was (Toolbar.tsx).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PencilLine } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { VimModeBadge } from './VimModeBadge'
import { Hint, HintBar, vimKeyCaps } from './KeyHints'
import { closeUrlEditor, useUrlEditorStore } from '../lib/url-editor'
import { openAddress } from '../lib/open-address'
import { blockByKey, removeBlock, replaceBlock, siteOnly, upOneLevel, urlBlocks, type UrlBlock } from '../lib/url-blocks'
import { usePopupVimMode } from '../lib/vim-mode'
import { keyTokenFromEvent, type VimKeymap } from '../lib/vim-keymap'

interface Props {
  /** The page area: the editor sits at the top of it. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** The editor's COMMAND keys; null while Vim mode is off. */
  vimKeymap: VimKeymap | null
}

type Intent = 'change' | 'remove' | 'copy' | 'paste'

const INTENT_LABEL: Record<Intent, string> = { change: 'Change', remove: 'Remove', copy: 'Copy', paste: 'Paste over' }
const MAX_WIDTH = 1100
const HEIGHT = 164
const INSET_TOP = 20
// How long y / p wait for a block key before acting on the whole address
// (y copies it at once and only narrows down if a key follows).
const INTENT_TIMEOUT_MS = 700
const FLASH_MS = 1600
// The address at twice the usual size, shrinking to fit a long one — down
// to the usual size, past which the box scrolls.
const FONT_PX = 28
const MIN_FONT_PX = 14

const isMac = navigator.platform.toLowerCase().includes('mac')

/** First line, trimmed — what a paste means in a one-line box. */
function oneLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? '').trim()
}

interface Mark {
  block: UrlBlock
  left: number
  width: number
}

export function UrlEditor({ anchorRef, vimKeymap }: Props) {
  const open = useUrlEditorStore((s) => s.open)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const [popupWindow, setPopupWindow] = useState<Window | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The box once it's in the popup: the blocks under it are measured off it.
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null)
  const bindInput = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el
    setInputEl(el)
  }, [])
  const [value, setValueState] = useState('')
  const valueRef = useRef('')
  // The tab being edited, and what it was showing.
  const [target, setTarget] = useState<{ tabId: string; url: string; title: string } | null>(null)
  const [intent, setIntentState] = useState<Intent | null>(null)
  const intentRef = useRef<Intent | null>(null)
  const intentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Changes made in COMMAND mode, for U.
  const historyRef = useRef<string[]>([])
  // Where typing left off, for i.
  const lastSelRef = useRef<{ start: number; end: number } | null>(null)
  const [size, setSize] = useState<{ width: number } | null>(null)
  const [placement, setPlacement] = useState<PopupPlacement>()
  const [scrollLeft, setScrollLeft] = useState(0)
  const [marks, setMarks] = useState<Mark[]>([])
  const [inputWidth, setInputWidth] = useState(0)
  const [fontPx, setFontPx] = useState(FONT_PX)
  // Bumped when the box changes size — it has none until the popup lays out.
  const [layoutTick, setLayoutTick] = useState(0)
  useEffect(() => {
    const view = inputEl?.ownerDocument.defaultView as (Window & typeof globalThis) | null | undefined
    if (!inputEl || !view) return
    const ro = new view.ResizeObserver(() => setLayoutTick((t) => t + 1))
    ro.observe(inputEl)
    return () => ro.disconnect()
  }, [inputEl])

  const setValue = useCallback((next: string, remember: boolean) => {
    if (remember && next !== valueRef.current) historyRef.current.push(valueRef.current)
    valueRef.current = next
    setValueState(next)
  }, [])

  const showFlash = useCallback((text: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlash(text)
    flashTimerRef.current = setTimeout(() => setFlash(null), FLASH_MS)
  }, [])

  // Opening: the active tab's address, COMMAND mode, nothing selected.
  useEffect(() => {
    if (!open) {
      setTarget(null)
      setSize(null)
      setPlacement(undefined)
      return
    }
    const tab = useAppStore.getState().getActiveTab()
    if (!tab) {
      closeUrlEditor()
      return
    }
    setTarget({ tabId: tab.id, url: tab.url, title: tab.title })
    historyRef.current = []
    lastSelRef.current = null
    setValue(tab.url === 'about:blank' ? '' : tab.url, false)
    setIntentState(null)
    intentRef.current = null
    setFlash(null)
  }, [open, setValue])

  // Another tab coming to the front takes the editor's subject away.
  useEffect(() => {
    if (open && target && activeTabId !== target.tabId) closeUrlEditor()
  }, [open, target, activeTabId])

  // The top of the page area, as wide as fits (taken once: the popup's
  // window keeps its size), following the page area around.
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const width = size?.width ?? Math.round(Math.max(420, Math.min(MAX_WIDTH, r.width - 48)))
      if (!size) setSize({ width })
      const next = { left: Math.round(r.left + (r.width - width) / 2), top: Math.round(r.top + INSET_TOP) }
      setPlacement((prev) => (prev?.left === next.left && prev.top === next.top ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, size])

  // Where each block sits under the text: measured in the box's own font,
  // less however far the box has scrolled sideways.
  const blocks = useMemo(() => urlBlocks(value), [value])
  useLayoutEffect(() => {
    const input = inputEl
    if (!input) {
      setMarks([])
      return
    }
    setInputWidth(input.clientWidth)
    const style = input.ownerDocument.defaultView?.getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')
    if (!style || !ctx) return
    const padding = parseFloat(style.paddingLeft) || 0
    const room = input.clientWidth - padding - (parseFloat(style.paddingRight) || 0) - 2
    // How big the whole address fits, from its width at full size.
    ctx.font = `${style.fontWeight} ${FONT_PX}px ${style.fontFamily}`
    const full = ctx.measureText(value).width
    const fit = full > room && room > 0 ? Math.max(MIN_FONT_PX, Math.floor((FONT_PX * room) / full)) : FONT_PX
    if (fit !== fontPx) {
      setFontPx(fit)
      return
    }
    ctx.font = `${style.fontWeight} ${fit}px ${style.fontFamily}`
    const measure = (text: string): number => ctx.measureText(text).width
    setMarks(blocks.map((block) => ({
      block,
      left: padding + measure(value.slice(0, block.start)) - scrollLeft,
      width: Math.max(4, measure(value.slice(block.start, block.end))),
    })))
  }, [blocks, value, scrollLeft, inputEl, layoutTick, fontPx])

  const syncScroll = (): void => {
    const input = inputRef.current
    if (input && input.scrollLeft !== scrollLeft) setScrollLeft(input.scrollLeft)
  }

  /** Into typing with `start..end` selected (a caret when equal). */
  const typeAt = useCallback((start: number, end = start) => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    const max = valueRef.current.length
    input.setSelectionRange(Math.min(start, max), Math.min(end, max))
    requestAnimationFrame(() => setScrollLeft(input.scrollLeft))
  }, [])

  const disarm = useCallback(() => {
    if (intentTimerRef.current) clearTimeout(intentTimerRef.current)
    intentTimerRef.current = null
    intentRef.current = null
    setIntentState(null)
  }, [])

  const readClipboard = async (): Promise<string> => oneLine(await window.electronAPI.clipboardReadText?.() ?? '')

  const pasteWhole = useCallback(async () => {
    const text = await readClipboard()
    if (!text) {
      showFlash('The clipboard has no text')
      return
    }
    setValue(text, true)
    showFlash('Pasted over the address')
  }, [setValue, showFlash])

  const arm = useCallback((next: Intent) => {
    disarm()
    // The intent's prompt takes the hint bar from an old message.
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlash(null)
    intentRef.current = next
    setIntentState(next)
    if (next === 'copy') {
      // At once — a block key that follows narrows it to the block.
      window.electronAPI.clipboardWriteText(valueRef.current)
      showFlash('Copied the address')
    }
    if (next === 'copy' || next === 'paste') {
      intentTimerRef.current = setTimeout(() => {
        const was = intentRef.current
        disarm()
        if (was === 'paste') void pasteWhole()
      }, INTENT_TIMEOUT_MS)
    }
  }, [disarm, pasteWhole, showFlash])

  /** The intent on `block` — or, for a block the address lacks, what can be
   *  done about that. */
  const applyIntent = useCallback(async (kind: Intent, key: string) => {
    const text = valueRef.current
    const block = blockByKey(text, key)
    if (!block) {
      // Parameters and a fragment can be started from nothing.
      if (kind === 'change' && (key === 's' || key === 'f')) {
        const hash = text.indexOf('#')
        const next = key === 's'
          ? hash === -1 ? `${text}?` : `${text.slice(0, hash)}?${text.slice(hash)}`
          : `${text}#`
        setValue(next, true)
        const at = key === 's' && hash !== -1 ? hash + 1 : next.length
        requestAnimationFrame(() => typeAt(at))
        return
      }
      showFlash(`No block ${key} in this address`)
      return
    }
    const part = text.slice(block.start, block.end)
    switch (kind) {
      case 'change':
        typeAt(block.start, block.end)
        break
      case 'remove':
        setValue(removeBlock(text, block), true)
        showFlash(`Removed the ${block.label}`)
        break
      case 'copy':
        window.electronAPI.clipboardWriteText(part)
        showFlash(`Copied the ${block.label}: ${part}`)
        break
      case 'paste': {
        const pasted = await readClipboard()
        if (!pasted) {
          showFlash('The clipboard has no text')
          break
        }
        setValue(replaceBlock(text, block, pasted), true)
        showFlash(`Pasted over the ${block.label}`)
        break
      }
    }
  }, [setValue, showFlash, typeAt])

  const go = useCallback((inNewTab: boolean) => {
    const text = valueRef.current.trim()
    const unchanged = target && text === target.url
    if (text && (!unchanged || inNewTab)) openAddress(text, inNewTab, 'url-editor')
    closeUrlEditor()
  }, [target])

  const onCommand = (command: string): void => {
    switch (command) {
      case 'url-change': arm('change'); break
      case 'url-remove': arm('remove'); break
      case 'url-copy': arm('copy'); break
      case 'url-paste': arm('paste'); break
      case 'url-up': setValue(upOneLevel(valueRef.current), true); break
      case 'url-site': setValue(siteOnly(valueRef.current), true); break
      case 'url-copy-title':
        if (target?.title) {
          window.electronAPI.clipboardWriteText(target.title)
          showFlash(`Copied the title: ${target.title}`)
        }
        break
      case 'url-clear':
        setValue('', true)
        requestAnimationFrame(() => typeAt(0))
        break
      case 'url-append': typeAt(valueRef.current.length); break
      case 'url-insert-start': typeAt(0); break
      case 'url-insert': {
        const sel = lastSelRef.current
        if (sel) typeAt(sel.start, sel.end)
        else typeAt(valueRef.current.length)
        break
      }
      case 'url-undo': {
        const previous = historyRef.current.pop()
        if (previous === undefined) showFlash('Nothing to undo')
        else setValue(previous, false)
        break
      }
      case 'url-go': go(false); break
    }
  }

  // After an intent, the next key names a block (or gives up on it).
  const intercept = (e: KeyboardEvent): boolean => {
    const kind = intentRef.current
    if (!kind) return false
    const token = keyTokenFromEvent(e)
    if (!token) return false
    if (token === '<Esc>') {
      disarm()
      return true
    }
    if (/^[pdsf1-9]$/.test(token)) {
      disarm()
      void applyIntent(kind, token)
      return true
    }
    // Anything else: a waiting paste goes over the whole address, and the
    // key does what it does.
    disarm()
    if (kind === 'paste') void pasteWhole()
    return false
  }

  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'command',
    open,
    onCommand,
    onEscape: closeUrlEditor,
    intercept,
  })

  // Without Vim mode the box has the keys from the start.
  useEffect(() => {
    if (!popupWindow || vimKeymap) return
    const t = setTimeout(() => typeAt(valueRef.current.length), 0)
    return () => clearTimeout(t)
  }, [popupWindow, vimKeymap, typeAt])

  useEffect(() => () => {
    if (intentTimerRef.current) clearTimeout(intentTimerRef.current)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  if (!open || !target || !size || !placement) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Vim: Esc leaves the box for COMMAND mode; Esc there closes.
      if (vim.modeRef.current) e.currentTarget.blur()
      else closeUrlEditor()
    }
  }

  const caps = (...commands: string[]): string[] => vimKeyCaps(vimKeymap, ...commands)
  const shift = isMac ? '⇧' : 'Shift'
  const edited = value !== target.url

  return (
    <DetachedWindow
      open
      title="Edit Address - Newbro"
      width={size.width}
      height={HEIGHT}
      resizable={false}
      // In Vim mode Esc first leaves the box; the editor handles it.
      closeOnEscape={!vimKeymap}
      placement={placement}
      onClose={closeUrlEditor}
      onWindowChange={setPopupWindow}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-4 pt-3 pb-1 shrink-0">
          <PencilLine size={18} className={`shrink-0 ${edited ? 'text-primary' : 'text-muted-foreground'}`} />
          <input
            ref={bindInput}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value, false)}
            onKeyDown={onKeyDown}
            onFocus={vim.onBoxFocus}
            onBlur={(e) => {
              lastSelRef.current = { start: e.currentTarget.selectionStart ?? 0, end: e.currentTarget.selectionEnd ?? 0 }
              vim.onBoxBlur()
            }}
            onScroll={syncScroll}
            onSelect={syncScroll}
            spellCheck={false}
            autoComplete="off"
            placeholder="Address"
            style={{ fontSize: fontPx }}
            className="flex-1 min-w-0 h-11 bg-transparent border-none outline-none font-mono leading-none text-foreground placeholder:text-muted-foreground"
          />
          {vim.mode && <VimModeBadge mode={vim.mode} pending={vim.pending} />}
        </div>

        {/* The blocks under the text, each with its quick-edit key — lit
            while an intent waits for one. */}
        <div className="relative ml-[46px] h-[54px] shrink-0 overflow-hidden select-none" style={{ width: inputWidth }}>
          {marks.map(({ block, left, width }) => (
            <div
              key={`${block.kind}-${block.start}`}
              className="absolute top-0 flex flex-col items-center"
              style={{ left, width }}
            >
              <div className={`h-1.5 w-full rounded-b border-x border-b ${intent ? 'border-primary/70' : 'border-muted-foreground/40'}`} />
              {/* A label wider than its block would run into the next one. */}
              <span className={`mt-0.5 whitespace-nowrap text-[10px] uppercase tracking-wider text-muted-foreground ${width < block.label.length * 7 + 4 ? 'invisible' : ''}`}>
                {block.label}
              </span>
              {block.key && (
              <kbd
                className={`mt-0.5 font-mono text-[11px] transition-opacity ${intent ? 'opacity-100' : 'opacity-45'}`}
                data-on-field={intent ? '' : undefined}
                onMouseDown={(e) => {
                  // A click on a block's key changes that block.
                  e.preventDefault()
                  void applyIntent(intent ?? 'change', block.key)
                  disarm()
                }}
              >
                {block.key}
              </kbd>
              )}
            </div>
          ))}
        </div>

        <HintBar edge="bottom" wrap className="mt-auto">
          {intent ? (
            <>
              {flash && <span>{flash} ·</span>}
              <span className="text-foreground">{INTENT_LABEL[intent]} — which block? Press its key above</span>
              {(intent === 'copy' || intent === 'paste') && <span>(or wait: the whole address)</span>}
              <Hint label="Cancel" keys={['Esc']} />
            </>
          ) : flash ? (
            <span className="text-foreground">{flash}</span>
          ) : vim.mode === 'command' ? (
            <>
              <Hint label="Change" keys={caps('url-change')} />
              <Hint label="Remove" keys={caps('url-remove')} />
              <Hint label="Copy" keys={caps('url-copy')} />
              <Hint label="Paste" keys={caps('url-paste')} />
              <Hint label="Up" keys={caps('url-up')} />
              <Hint label="Site" keys={caps('url-site')} />
              <Hint label="Title" keys={caps('url-copy-title')} />
              <Hint label="Type" keys={caps('url-insert', 'url-append', 'url-insert-start')} />
              <Hint label="Clear" keys={caps('url-clear')} />
              <Hint label="Undo" keys={caps('url-undo')} />
              <Hint label="Go" keys={caps('url-go')} />
              <Hint label="Close" keys={['Esc']} />
            </>
          ) : (
            <>
              <Hint label="Go" keys={['Enter']} />
              <Hint label="New tab" keys={[shift, 'Enter']} />
              <Hint label={vim.mode ? 'Command mode' : 'Close'} keys={['Esc']} />
            </>
          )}
        </HintBar>
      </div>
    </DetachedWindow>
  )
}
