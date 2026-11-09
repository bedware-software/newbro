// The address bar's moon: whether the page is dark (filled) or not
// (outlined), a dot when its site has a rule of its own. A click opens the
// Dark pages popover — the switch, this site, the comfort sliders — over the
// page; the shortcuts toggle without it. Vim's oD opens it from the keys,
// its first control focused; in it j/k (or ↓/↑) go from control to control,
// h/l (or ←/→) move a slider or along the mode switch, Enter or Space
// presses, Esc closes.

import { useEffect, useRef, useState } from 'react'
import { log } from '../lib/log'
import { Moon, Settings2 } from 'lucide-react'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { Hint, HintBar } from './KeyHints'
import { useHeaderHint } from './HeaderHint'
import { ComfortSliders, DarkPagesModeSwitch, ToggleSwitch, acceleratorChord } from './DarkPagesControls'
import { cn } from '../lib/utils'
import { darkPagesActions, pageLook, useDarkPages } from '../lib/dark-pages'
import { isInternalUrl } from '../lib/internal-pages'
import { actionHint, type HintSettings } from '../lib/shortcut-hints'
import { darkPagesApplies, darkPagesGloballyOn } from '../../../shared/dark-pages'

const WIDTH = 356
const HEIGHT = 262
// A click on the moon right after the popover lost the focus to it is the
// click that closed it, not one to open it again.
const REOPEN_GUARD_MS = 250
// How far h/l move a comfort slider, in its percent.
const SLIDER_STEP = 5

/** The action's key as one cap — a chord too, so the bar stays short. */
function keyCap(settings: HintSettings | null, action: string, fallback: string): string[] {
  const hint = actionHint(settings, action, fallback)
  if (!hint) return []
  return [hint.kind === 'vim' ? hint.keys : acceleratorChord(hint.accelerator)]
}

export function DarkPagesButton({ url, onOpenSettings }: { url: string; onOpenSettings: () => void }) {
  const dp = useDarkPages()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [placement, setPlacement] = useState<PopupPlacement | null>(null)
  // Opened from the keys: its first control takes the focus.
  const [byKeys, setByKeys] = useState(false)
  const closedAt = useRef(0)

  const shown = !!url && !isInternalUrl(url) && darkPagesApplies(url)
  // The page went somewhere the moon isn't for: the popover goes too.
  useEffect(() => { if (!shown) setPlacement(null) }, [shown])

  const placementBelow = (): PopupPlacement | null => {
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return null
    return {
      left: Math.max(8, Math.round(Math.min(r.right + 8, window.innerWidth - 8) - WIDTH)),
      top: Math.round(r.bottom + 10),
    }
  }

  // Vim's oD (App.tsx sends the event): opened, or left open, from the keys.
  const openByKeysRef = useRef<() => void>(() => {})
  openByKeysRef.current = () => {
    if (!shown) {
      log.info('dark-pages-menu: no Dark pages for this page')
      return
    }
    const spot = placement ?? placementBelow()
    if (!spot) return
    setByKeys(true)
    setPlacement(spot)
  }
  useEffect(() => {
    const onOpen = (): void => openByKeysRef.current()
    window.addEventListener('vimperium-open-dark-pages-menu', onOpen)
    return () => window.removeEventListener('vimperium-open-dark-pages-menu', onOpen)
  }, [])
  // Its label in COMMAND opens it as oD does.
  const hint = useHeaderHint('dark', shown ? () => openByKeysRef.current() : null)

  if (!shown) return null

  const look = pageLook(dp, url)
  const globallyOn = darkPagesGloballyOn(dp.config, dp.appDark)
  const where = look.site ?? 'this page'
  const title = look.dark
    ? `Dark pages: ${where} is dark${look.rule ? ' (your rule)' : ''}. Click for options`
    : `Dark pages: ${where} isn't darkened${look.rule ? ' (your rule)' : globallyOn ? '' : ' — Dark pages are off'}. Click for options`

  // A click with no press behind it (detail 0) came from the keys — a ;
  // label — and opens it as oD does.
  const toggleOpen = (byKeyboard: boolean): void => {
    if (placement) {
      setPlacement(null)
      return
    }
    if (Date.now() - closedAt.current < REOPEN_GUARD_MS) return
    const spot = placementBelow()
    if (!spot) return
    setByKeys(byKeyboard)
    setPlacement(spot)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => toggleOpen(e.detail === 0)}
        title={title}
        aria-label="Dark pages"
        aria-pressed={look.dark}
        className={cn(
          'relative mr-1 h-6 w-6 shrink-0 flex items-center justify-center rounded-md transition-colors',
          placement ? 'bg-secondary' : 'hover:bg-secondary',
          look.dark ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {hint}
        <Moon
          size={13}
          strokeWidth={look.dark ? 2.2 : 2}
          fill={look.dark ? 'currentColor' : 'none'}
          className="transition-all duration-200"
        />
        {look.rule && (
          <span
            className={cn(
              'absolute bottom-[3px] right-[3px] h-[5px] w-[5px] rounded-full ring-1 ring-[var(--color-field)]',
              look.rule === 'dark' ? 'bg-primary' : 'bg-muted-foreground',
            )}
          />
        )}
      </button>
      {placement && (
        <DarkPagesPopover
          url={url}
          placement={placement}
          byKeys={byKeys}
          onClose={() => {
            closedAt.current = Date.now()
            setPlacement(null)
          }}
          onOpenSettings={() => {
            setPlacement(null)
            onOpenSettings()
          }}
        />
      )}
    </>
  )
}

/** The controls the keys go between, in the order they're laid out. */
function popoverControls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, input')].filter((el) => !el.matches(':disabled'))
}

/** j/k, h/l in the popover (see the top of the file). Elements are of the
 *  popup's own window, so they go by tag and role, not instanceof. */
function onPopoverKey(e: KeyboardEvent, doc: Document): void {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const move = /^Key[JKHL]$/.test(e.code) && !e.shiftKey ? e.code.slice(3).toLowerCase() : e.key
  const focused = doc.activeElement as HTMLElement | null
  const controls = popoverControls(doc)
  if (move === 'j' || move === 'k' || move === 'ArrowDown' || move === 'ArrowUp') {
    if (controls.length === 0) return
    e.preventDefault()
    const at = focused ? controls.indexOf(focused) : -1
    const step = move === 'j' || move === 'ArrowDown' ? 1 : -1
    const next = at === -1 ? (step === 1 ? 0 : controls.length - 1) : Math.max(0, Math.min(controls.length - 1, at + step))
    controls[next].focus()
    return
  }
  if (move !== 'h' && move !== 'l' && move !== 'ArrowLeft' && move !== 'ArrowRight') return
  if (!focused) return
  const dir = move === 'l' || move === 'ArrowRight' ? 1 : -1
  if (focused.tagName === 'INPUT' && (focused as HTMLInputElement).type === 'range') {
    e.preventDefault()
    const input = focused as HTMLInputElement
    for (let i = 0; i < SLIDER_STEP; i++) {
      if (dir === 1) input.stepUp()
      else input.stepDown()
    }
    // React hears a slider move as its input event.
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  if (focused.getAttribute('role') === 'radio') {
    const group = focused.closest('[role="radiogroup"]')
    const radios = group ? [...group.querySelectorAll<HTMLElement>('[role="radio"]')] : []
    const next = radios[radios.indexOf(focused) + dir]
    if (!next) return
    e.preventDefault()
    next.focus()
    next.click()
  }
}

function DarkPagesPopover({ url, placement, byKeys, onClose, onOpenSettings }: {
  url: string
  placement: PopupPlacement
  /** Opened from the keys: the first control takes the focus. */
  byKeys: boolean
  onClose: () => void
  onOpenSettings: () => void
}) {
  const dp = useDarkPages()
  const [hintSettings, setHintSettings] = useState<HintSettings | null>(null)
  const [popup, setPopup] = useState<Window | null>(null)
  useEffect(() => {
    window.electronAPI.loadSettings()
      .then((s) => setHintSettings(s as HintSettings))
      .catch((err: unknown) => log.warn('dark pages popover: settings unreadable, no key hints', err))
  }, [])

  useEffect(() => {
    if (!popup) return
    const doc = popup.document
    const onKey = (e: KeyboardEvent): void => onPopoverKey(e, doc)
    doc.addEventListener('keydown', onKey)
    return () => doc.removeEventListener('keydown', onKey)
  }, [popup])
  // From the keys, the first control (the mode switch's current choice)
  // takes the focus once the popup has painted.
  useEffect(() => {
    if (!popup || !byKeys) return
    const id = popup.requestAnimationFrame(() => {
      const doc = popup.document
      const current = doc.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ;(current ?? popoverControls(doc)[0])?.focus()
    })
    return () => popup.cancelAnimationFrame(id)
  }, [popup, byKeys])

  const look = pageLook(dp, url)
  const ownRule = look.rule && look.ruleSite === look.site
  const status = look.rule
    ? ownRule
      ? look.rule === 'dark' ? 'Always dark here' : 'Never dark here'
      : `${look.rule === 'dark' ? 'Always' : 'Never'} dark on ${look.ruleSite}`
    : look.dark
      ? look.repaint ? 'Dark — following the switch' : "Its own dark theme, if it has one"
      : 'Not dark — following the switch'

  return (
    <DetachedWindow
      open
      title="Dark pages"
      width={WIDTH}
      height={HEIGHT}
      resizable={false}
      closeOnBlur
      placement={placement}
      onClose={onClose}
      onWindowChange={setPopup}
    >
      <div data-key-ring className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground">
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Moon size={14} fill="currentColor" />
          </span>
          <span className="text-sm font-semibold text-foreground">Dark pages</span>
          <span className="ml-auto">
            <DarkPagesModeSwitch compact />
          </span>
        </div>

        <div className="mx-3.5 flex min-h-[54px] items-center gap-3 rounded-lg bg-secondary/60 px-3 py-2">
          {look.site ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{look.site}</div>
                <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                  <span className="truncate">{status}</span>
                  {look.rule && (
                    <button
                      type="button"
                      onClick={() => darkPagesActions.setSite(look.ruleSite!, null)}
                      className="shrink-0 font-medium text-primary hover:underline"
                      title={`Drop the rule for ${look.ruleSite}: it follows the switch again`}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <ToggleSwitch
                on={look.dark}
                label={`Dark on ${look.site}`}
                title={look.dark ? `Turn Dark pages off for ${look.site}` : `Turn Dark pages on for ${look.site}`}
                onToggle={() => darkPagesActions.setPage(url, !look.dark)}
              />
            </>
          ) : (
            <div className="text-[11px] leading-snug text-muted-foreground">
              This page has no site of its own — it follows the switch above.
            </div>
          )}
        </div>

        <div className="flex-1 px-3.5 pt-3 pb-2">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">Comfort</div>
          <ComfortSliders compact />
        </div>

        <HintBar className="justify-between gap-x-3 px-3.5">
          <span className="flex items-center gap-3">
            <Hint label="This site" keys={keyCap(hintSettings, 'dark-pages-site', 'Alt+Shift+A')} />
            <Hint label="Everywhere" keys={keyCap(hintSettings, 'dark-pages', 'Alt+Shift+D')} />
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            className="-mr-1.5 flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Settings2 size={12} />
            Settings
          </button>
        </HintBar>
      </div>
    </DetachedWindow>
  )
}
