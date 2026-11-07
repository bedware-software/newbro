// The address bar's moon: whether the page is dark (filled) or not
// (outlined), a dot when its site has a rule of its own. A click opens the
// Dark pages popover — the switch, this site, the comfort sliders — over the
// page; the shortcuts toggle without it.

import { useEffect, useRef, useState } from 'react'
import { Moon, Settings2 } from 'lucide-react'
import { DetachedWindow, type PopupPlacement } from './DetachedWindow'
import { Hint, HintBar } from './KeyHints'
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
  const closedAt = useRef(0)

  const shown = !!url && !isInternalUrl(url) && darkPagesApplies(url)
  // The page went somewhere the moon isn't for: the popover goes too.
  useEffect(() => { if (!shown) setPlacement(null) }, [shown])
  if (!shown) return null

  const look = pageLook(dp, url)
  const globallyOn = darkPagesGloballyOn(dp.config, dp.appDark)
  const where = look.site ?? 'this page'
  const title = look.dark
    ? `Dark pages: ${where} is dark${look.rule ? ' (your rule)' : ''}. Click for options`
    : `Dark pages: ${where} isn't darkened${look.rule ? ' (your rule)' : globallyOn ? '' : ' — Dark pages are off'}. Click for options`

  const toggleOpen = (): void => {
    if (placement) {
      setPlacement(null)
      return
    }
    if (Date.now() - closedAt.current < REOPEN_GUARD_MS) return
    const r = buttonRef.current?.getBoundingClientRect()
    if (!r) return
    setPlacement({
      left: Math.max(8, Math.round(Math.min(r.right + 8, window.innerWidth - 8) - WIDTH)),
      top: Math.round(r.bottom + 10),
    })
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggleOpen}
        title={title}
        aria-label="Dark pages"
        aria-pressed={look.dark}
        className={cn(
          'relative mr-1 h-6 w-6 shrink-0 flex items-center justify-center rounded-md transition-colors',
          placement ? 'bg-secondary' : 'hover:bg-secondary',
          look.dark ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
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

function DarkPagesPopover({ url, placement, onClose, onOpenSettings }: {
  url: string
  placement: PopupPlacement
  onClose: () => void
  onOpenSettings: () => void
}) {
  const dp = useDarkPages()
  const [hintSettings, setHintSettings] = useState<HintSettings | null>(null)
  useEffect(() => {
    window.electronAPI.loadSettings().then((s) => setHintSettings(s as HintSettings)).catch(() => {})
  }, [])

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
    >
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground">
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
