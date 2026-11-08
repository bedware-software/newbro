// The address editor (Vim's e): the page's title, and under it the active
// tab's address big in a field, cut into blocks — protocol, domain, port,
// each path level, parameters, fragment — labelled underneath with the key
// that names each one. In COMMAND mode an intent and a block's key act on
// that block: c changes it (selects it to type over), d removes it, y
// copies it, p pastes over it; the intent's key again (yy, cc) acts on the
// whole address — a block's key wins, so dd is the domain and pp the
// parameters, while D removes all of it and P pastes over all of it — and
// yt copies the page's title. gu goes up a level, gt keeps only the site; u undoes and <C-r>
// redoes, as in vim; i / A / I / C go to typing. Enter goes there. It opens typing over the whole address,
// selected, as other browsers' address bars do; Ctrl+C goes to COMMAND, and
// Esc closes from either.
// It drops down from the toolbar's address bar, edge to edge with it, the
// way the address bar's suggestions do — a pinned popup (tab pages are
// native views that paint over the app's DOM), not dragged anywhere — and
// is modal: the window behind it takes no clicks or focus until it closes. While it's up the toolbar shows workspace stats where the address
// bar was (Toolbar.tsx).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/app-store'
import { TabFavicon } from './TabFavicon'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { InputField } from './InputField'
import { Hint, HintBar, LEAVE_INSERT_CAP, vimKeyCaps } from './KeyHints'
import { closeUrlEditor, useUrlEditorStore } from '../lib/url-editor'
import { openAddress } from '../lib/open-address'
import { blockByKey, blockKeyLabel, isBlockKey, removeBlock, replaceBlock, siteOnly, startBlock, upOneLevel, urlBlocks, type UrlBlock } from '../lib/url-blocks'
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
// The command that arms each intent: its key pressed again means the whole
// address.
const INTENT_COMMAND: Record<Intent, string> = { change: 'url-change', remove: 'url-remove', copy: 'url-copy', paste: 'url-paste' }
// What acts on the whole address for each: the intent's key again, unless
// that's a block's key (dd the domain, pp the parameters).
const WHOLE_COMMAND: Record<Intent, string> = { change: 'url-change', remove: 'url-remove-all', copy: 'url-copy', paste: 'url-paste-all' }
const MAX_WIDTH = 1100
// After y, the page's title's key (yt), alongside the blocks'.
const TITLE_KEY = 't'
const MIN_WIDTH = 420
const HEIGHT = 196
const INSET_TOP = 20
// Between the address bar and the editor dropping down from it — the
// address bar's suggestions' gap (main/omnibox-popup.ts).
const BAR_GAP = 4
const FLASH_MS = 1600
// The address at twice the usual size, shrinking to fit a long one — down
// to the usual size, past which the box scrolls.
const FONT_PX = 28
const MIN_FONT_PX = 14
const PLACEHOLDER = 'Address'

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
  const [target, setTarget] = useState<{ tabId: string; url: string; title: string; favicon: string } | null>(null)
  const [intent, setIntentState] = useState<Intent | null>(null)
  const intentRef = useRef<Intent | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Changes made in COMMAND mode, for U.
  const historyRef = useRef<string[]>([])
  // What u took back, for <C-r>.
  const redoRef = useRef<string[]>([])
  // Where typing left off, for i.
  const lastSelRef = useRef<{ start: number; end: number } | null>(null)
  const [size, setSize] = useState<{ width: number } | null>(null)
  const [placement, setPlacement] = useState<PopupPlacement>()
  const [scrollLeft, setScrollLeft] = useState(0)
  const [marks, setMarks] = useState<Mark[]>([])
  const [fontPx, setFontPx] = useState(FONT_PX)
  // How far in the address starts, centring it.
  const [indent, setIndent] = useState(0)
  // Bumped when the box changes size — it has none until the popup lays out.
  const [layoutTick, setLayoutTick] = useState(0)
  useEffect(() => {
    const view = inputEl?.ownerDocument.defaultView as (Window & typeof globalThis) | null | undefined
    if (!inputEl || !view) return
    const ro = new view.ResizeObserver(() => setLayoutTick((t) => t + 1))
    ro.observe(inputEl)
    return () => ro.disconnect()
  }, [inputEl])

  /** Any change but an undo or redo's own drops what could be redone. */
  const setValue = useCallback((next: string, remember: boolean) => {
    if (remember && next !== valueRef.current) historyRef.current.push(valueRef.current)
    if (next !== valueRef.current) redoRef.current = []
    valueRef.current = next
    setValueState(next)
  }, [])

  const showFlash = useCallback((text: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlash(text)
    flashTimerRef.current = setTimeout(() => setFlash(null), FLASH_MS)
  }, [])

  // Opening: the active tab's address (selected once the box is up).
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
    setTarget({ tabId: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon })
    historyRef.current = []
    redoRef.current = []
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

  // Just under the address bar, edge to edge with it (its width taken once:
  // the popup's window keeps its size), following it around. With no
  // address bar showing (page fullscreen), at the top of the page area,
  // centred, as wide as fits.
  useEffect(() => {
    const el = anchorRef.current
    if (!open || !el) return
    const urlBar = (): DOMRect | null => {
      const r = document.querySelector('[data-url-bar]')?.getBoundingClientRect()
      return r && r.width > 0 ? r : null
    }
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const bar = urlBar()
      const width = size?.width ?? Math.round(bar
        ? Math.max(MIN_WIDTH, bar.width)
        : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, r.width - 48)))
      if (!size) setSize({ width })
      const next = {
        left: Math.round(Math.max(0, Math.min(window.innerWidth - width,
          bar ? bar.left + (bar.width - width) / 2 : r.left + (r.width - width) / 2))),
        top: Math.round(Math.max(0, Math.min(window.innerHeight - HEIGHT,
          bar ? bar.bottom + BAR_GAP : r.top + INSET_TOP))),
      }
      setPlacement((prev) => (prev?.left === next.left && prev.top === next.top ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const barEl = document.querySelector('[data-url-bar]')
    if (barEl) ro.observe(barEl)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, anchorRef, size])

  // Where each block sits under the text: measured in the box's own font,
  // past the indent that centres an address shorter than the box, less
  // however far the box has scrolled sideways.
  const blocks = useMemo(() => urlBlocks(value), [value])
  useLayoutEffect(() => {
    const input = inputEl
    if (!input) {
      setMarks([])
      return
    }
    const style = input.ownerDocument.defaultView?.getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')
    if (!style || !ctx) return
    // Past the last character, room for the caret.
    const room = input.clientWidth - 2
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
    // Centred on the field — under the title — rather than on the box,
    // which the mode at the field's end makes shorter: as far as the box
    // lets it, and from its start once it no longer fits.
    const field = input.parentElement?.getBoundingClientRect()
    const box = input.getBoundingClientRect()
    const middle = field ? field.left + field.width / 2 - box.left : input.clientWidth / 2
    const width = measure(value || PLACEHOLDER)
    const nextIndent = Math.round(Math.max(0, Math.min(middle - width / 2, room - width)))
    if (nextIndent !== indent) {
      setIndent(nextIndent)
      return
    }
    setMarks(blocks.map((block) => ({
      block,
      left: indent + measure(value.slice(0, block.start)) - scrollLeft,
      width: Math.max(4, measure(value.slice(block.start, block.end))),
    })))
  }, [blocks, value, scrollLeft, inputEl, layoutTick, fontPx, indent])

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

  /** An intent waits for the key that says what it's on, however long. */
  const arm = useCallback((next: Intent) => {
    disarm()
    // The intent's prompt takes the hint bar from an old message.
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlash(null)
    intentRef.current = next
    setIntentState(next)
  }, [disarm])

  /** The intent on the whole address. */
  const applyWhole = useCallback((kind: Intent) => {
    const text = valueRef.current
    switch (kind) {
      case 'change':
        typeAt(0, text.length)
        break
      case 'remove':
        setValue('', true)
        showFlash('Removed the address')
        break
      case 'copy':
        window.electronAPI.clipboardWriteText(text)
        showFlash('Copied the address')
        break
      case 'paste':
        void pasteWhole()
        break
    }
  }, [pasteWhole, setValue, showFlash, typeAt])

  /** The intent on `block` — or, for a block the address lacks, what can be
   *  done about that. */
  const applyIntent = useCallback(async (kind: Intent, key: string) => {
    const text = valueRef.current
    const block = blockByKey(text, key)
    if (!block) {
      // A port, parameters and a fragment can be started from nothing.
      const started = kind === 'change' ? startBlock(text, key) : null
      if (started) {
        setValue(started.text, true)
        requestAnimationFrame(() => typeAt(started.at))
        return
      }
      showFlash(`No ${blockKeyLabel(key)} in this address`)
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

  const copyTitle = (): void => {
    if (!target?.title) {
      showFlash('This page has no title')
      return
    }
    window.electronAPI.clipboardWriteText(target.title)
    showFlash(`Copied the title: ${target.title}`)
  }

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
      case 'url-remove-all': applyWhole('remove'); break
      case 'url-copy': arm('copy'); break
      case 'url-paste': arm('paste'); break
      case 'url-paste-all': void pasteWhole(); break
      case 'url-up': setValue(upOneLevel(valueRef.current), true); break
      case 'url-site': setValue(siteOnly(valueRef.current), true); break
      case 'url-copy-title': copyTitle(); break
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
        if (previous === undefined) {
          showFlash('Nothing to undo')
          break
        }
        const redo = [...redoRef.current, valueRef.current]
        setValue(previous, false)
        redoRef.current = redo
        break
      }
      case 'url-redo': {
        const redo = [...redoRef.current]
        const next = redo.pop()
        if (next === undefined) {
          showFlash('Nothing to redo')
          break
        }
        historyRef.current.push(valueRef.current)
        setValue(next, false)
        redoRef.current = redo
        break
      }
      case 'url-go': go(false); break
    }
  }

  // After an intent, the next key names a block — or, the intent's own key
  // again, the whole address (vim's yy). A block key wins: p is the
  // parameters', so pp pastes over them and P over the whole address. After
  // y, t is the page's title.
  const intercept = (e: KeyboardEvent): boolean => {
    const kind = intentRef.current
    if (!kind) return false
    const token = keyTokenFromEvent(e)
    if (!token) return false
    disarm()
    if (token === '<Esc>') return true
    if (kind === 'copy' && token === TITLE_KEY) {
      copyTitle()
      return true
    }
    if (isBlockKey(token)) {
      void applyIntent(kind, token)
      return true
    }
    if (vimKeymap?.get(token) === INTENT_COMMAND[kind]) {
      applyWhole(kind)
      return true
    }
    // Anything else gives up on the intent and does what it does.
    return false
  }

  const vim = usePopupVimMode({
    keymap: vimKeymap,
    popup: popupWindow,
    box: inputRef,
    initial: 'insert',
    open,
    onCommand,
    onEscape: closeUrlEditor,
    intercept,
  })

  // The box has the keys from the start, the whole address selected — typing
  // replaces it, as in any address bar; Vim's Ctrl+C goes to COMMAND.
  useEffect(() => {
    if (!popupWindow) return
    const t = setTimeout(() => typeAt(0, valueRef.current.length), 0)
    return () => clearTimeout(t)
  }, [popupWindow, typeAt])

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  if (!open || !target || !size || !placement) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      go(e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // In Vim mode Esc never gets here: the editor's Vim keys close it.
      closeUrlEditor()
    }
  }

  const caps = (...commands: string[]): string[] => vimKeyCaps(vimKeymap, ...commands)
  const shift = isMac ? '⇧' : 'Shift'

  return (
    <DetachedWindow
      open
      title="Edit Address - Vimperium"
      width={size.width}
      height={HEIGHT}
      resizable={false}
      modal
      // In Vim mode Esc is the editor's Vim keys' (usePopupVimMode).
      closeOnEscape={!vimKeymap}
      placement={placement}
      onClose={closeUrlEditor}
      onWindowChange={setPopupWindow}
    >
      {/* A press off the box keeps the box's focus and selection. */}
      <div
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault() }}
        className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col"
      >
        {/* The page's title — what yt copies, its key lit while y waits —
            centred over the address. */}
        <div className="flex items-center justify-center gap-2 h-8 mt-2 px-4 shrink-0">
          <TabFavicon favicon={target.favicon} globeSize={16} />
          <span className="min-w-0 truncate text-sm font-medium text-foreground" title={target.title}>
            {target.title || 'Untitled'}
          </span>
          {intent === 'copy' && (
            <kbd
              className="shrink-0 font-mono text-[11px]"
              data-on-field=""
              onMouseDown={(e) => {
                e.preventDefault()
                copyTitle()
                disarm()
              }}
            >
              {TITLE_KEY}
            </kbd>
          )}
        </div>

        <div className="px-4 pt-2 shrink-0">
          {/* The address in a field, the mode at its end. A press anywhere
              in the field types at the end. */}
          <div>
            <InputField
              inputRef={inputRef}
              onPress={() => typeAt(valueRef.current.length)}
              mode={vim.mode}
              pending={vim.pending}
              className="h-12"
            >
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
                placeholder={PLACEHOLDER}
                style={{ fontSize: fontPx, paddingLeft: indent }}
                className="flex-1 min-w-0 h-full bg-transparent border-none outline-none font-mono leading-none text-foreground placeholder:text-muted-foreground"
              />
            </InputField>
          </div>

          {/* The blocks under the text, each with its quick-edit key — lit
              while an intent waits for one. Padded as the field's left
              side is, so they line up with its text; stacked in one grid
              cell, so the row is as tall as the tallest, and clipped only
              at the sides, where the address scrolls. */}
          <div className="mt-1 pl-3">
            <div className="grid overflow-x-clip select-none">
              {marks.map(({ block, left, width }) => (
                <div
                  key={`${block.kind}-${block.start}`}
                  className="col-start-1 row-start-1 flex flex-col items-center"
                  style={{ marginLeft: left, width }}
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
          </div>
        </div>

        <HintBar wrap className="mt-auto">
          {intent ? (
            <>
              {flash && <span>{flash} ·</span>}
              <span className="text-foreground">{INTENT_LABEL[intent]} — which block? Press its key above</span>
              <Hint label="The whole address" keys={caps(WHOLE_COMMAND[intent])} />
              {intent === 'copy' && <Hint label="The title" keys={[TITLE_KEY]} />}
              <Hint label="Cancel" keys={['Esc']} />
            </>
          ) : flash ? (
            <span className="text-foreground">{flash}</span>
          ) : vim.mode === 'command' ? (
            <>
              <Hint label="Change" keys={caps('url-change')} />
              <Hint label="Remove" keys={caps('url-remove')} />
              <Hint label="Remove all" keys={caps('url-remove-all')} />
              <Hint label="Copy" keys={caps('url-copy')} />
              <Hint label="Paste" keys={caps('url-paste')} />
              <Hint label="Paste all" keys={caps('url-paste-all')} />
              <Hint label="Up" keys={caps('url-up')} />
              <Hint label="Site" keys={caps('url-site')} />
              <Hint label="Title" keys={caps('url-copy')[0] ? [`${caps('url-copy')[0]}${TITLE_KEY}`] : []} />
              <Hint label="Type" keys={caps('url-insert', 'url-append', 'url-insert-start')} />
              <Hint label="Clear" keys={caps('url-clear')} />
              <Hint label="Undo" keys={caps('url-undo')} />
              <Hint label="Redo" keys={caps('url-redo')} />
              <Hint label="Go" keys={caps('url-go')} />
              <Hint label="Close" keys={['Esc']} />
            </>
          ) : (
            <>
              <Hint label="Go" keys={['Enter']} />
              <Hint label="New tab" keys={[shift, 'Enter']} />
              {vim.mode && <Hint label="Command mode" keys={[LEAVE_INSERT_CAP]} />}
              <Hint label="Close" keys={['Esc']} />
            </>
          )}
        </HintBar>
      </div>
    </DetachedWindow>
  )
}
