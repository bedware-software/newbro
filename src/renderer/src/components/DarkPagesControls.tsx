// Dark pages' controls, shared by the address bar's popover
// (DarkPagesButton) and Settings → Dark pages (DarkPagesSettings): the
// Off / On / With-theme switch, the comfort sliders and a small toggle.

import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn } from '../lib/utils'
import { darkPagesActions, useDarkPages } from '../lib/dark-pages'
import { Switch } from './Switch'
import { DARK_PAGES_LIMITS, type DarkPagesMode } from '../../../shared/dark-pages'

const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac')

/** An accelerator as key caps: `Alt+Shift+D` → ⌥ ⇧ D on a Mac. */
export function acceleratorCaps(accelerator: string): string[] {
  return accelerator
    .split('+')
    .filter(Boolean)
    .map((part) =>
      part === 'CmdOrCtrl' ? (isMac ? '⌘' : 'Ctrl')
        : part === 'Shift' ? (isMac ? '⇧' : 'Shift')
          : part === 'Alt' ? (isMac ? '⌥' : 'Alt')
            : part)
}

/** An accelerator as one cap's text: ⌥⇧D on a Mac, Alt+Shift+D elsewhere. */
export function acceleratorChord(accelerator: string): string {
  return acceleratorCaps(accelerator).join(isMac ? '' : '+')
}

const MODES: { id: DarkPagesMode; label: string; short: string; hint: string }[] = [
  { id: 'off', label: 'Off', short: 'Off', hint: 'Pages look as their sites made them (sites you made always dark aside).' },
  { id: 'on', label: 'On', short: 'On', hint: 'Every page is dark (sites you made never dark aside).' },
  { id: 'theme', label: "With Vimperium's theme", short: 'Auto', hint: "Pages are dark while Vimperium's own theme is — Settings → Appearance; under System, as the OS switches." },
]

/** Off / On / With Vimperium's theme, as a segmented control. `vimItem`:
 *  its id for Vim's form keys (Settings). */
export function DarkPagesModeSwitch({ compact = false, className, vimItem }: { compact?: boolean; className?: string; vimItem?: string }) {
  const { config } = useDarkPages()
  return (
    <div
      role="radiogroup"
      aria-label="Dark pages"
      data-vim-item={vimItem}
      className={cn('flex w-fit items-center rounded-md bg-secondary p-0.5', compact ? 'h-7' : 'h-9', className)}
    >
      {MODES.map((m) => {
        const active = config.mode === m.id
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={m.hint}
            onClick={() => darkPagesActions.set({ mode: m.id })}
            className={cn(
              'flex items-center rounded font-medium transition-colors',
              compact ? 'h-6 px-2 text-[11px]' : 'h-8 px-3 text-xs',
              active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {compact ? m.short : m.label}
          </button>
        )
      })}
    </div>
  )
}

/** A small on/off switch — Settings' own (components/Switch.tsx). */
export function ToggleSwitch({ on, onToggle, title, label }: { on: boolean; onToggle: () => void; title?: string; label: string }) {
  return <Switch checked={on} onChange={() => onToggle()} title={title} label={label} />
}

type ComfortKey = 'brightness' | 'contrast' | 'warmth'

const SLIDERS: { key: ComfortKey; label: string; hint: string }[] = [
  { key: 'brightness', label: 'Brightness', hint: 'How bright dark pages are, text and pictures alike' },
  { key: 'contrast', label: 'Contrast', hint: 'Lower softens white text on black' },
  { key: 'warmth', label: 'Warmth', hint: 'A warm, sepia tint — easier on the eyes at night' },
]

/** Brightness, contrast and warmth of dark pages: live as they move.
 *  Double-click a slider to put it back. `vimItems`: each control has its
 *  id for Vim's form keys (Settings), dark:brightness and so on. */
export function ComfortSliders({ compact = false, disabled = false, vimItems = false }: { compact?: boolean; disabled?: boolean; vimItems?: boolean }) {
  const { config } = useDarkPages()
  const atRest = SLIDERS.every(({ key }) => config[key] === DARK_PAGES_LIMITS[key].default)
  return (
    <div className={cn('flex flex-col', compact ? 'gap-1.5' : 'gap-3')}>
      {SLIDERS.map(({ key, label, hint }) => {
        const { min, max, default: rest } = DARK_PAGES_LIMITS[key]
        const value = config[key]
        const pct = (v: number): string => `${((v - min) / (max - min)) * 100}%`
        return (
          <label key={key} className="flex items-center gap-3" title={`${hint}. Double-click to reset.`}>
            <span className={cn('shrink-0 text-muted-foreground', compact ? 'w-[68px] text-[11px]' : 'w-24 text-xs')}>{label}</span>
            <input
              data-vim-item={vimItems ? `dark:${key}` : undefined}
              type="range"
              className="slider min-w-0 flex-1"
              min={min}
              max={max}
              step={1}
              value={value}
              disabled={disabled}
              aria-label={label}
              style={{ '--fill': pct(value), '--rest': pct(rest) } as React.CSSProperties}
              onChange={(e) => darkPagesActions.set({ [key]: Number(e.target.value) })}
              onDoubleClick={() => darkPagesActions.set({ [key]: rest })}
            />
            <span className={cn('shrink-0 text-right tabular-nums text-foreground', compact ? 'w-9 text-[11px]' : 'w-10 text-xs')}>
              {value}%
            </span>
          </label>
        )
      })}
      {!compact && (
        <div className="flex justify-end">
          <button
            type="button"
            data-vim-item={vimItems ? 'dark:reset' : undefined}
            disabled={atRest || disabled}
            onClick={() => darkPagesActions.set({ brightness: 100, contrast: 100, warmth: 0 })}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
      )}
    </div>
  )
}

/** A miniature web page as Dark pages draws one — its look darkened the
 *  Chromium way, then the comfort filter over it, live — to judge the
 *  sliders by when no page is in sight. */
export function DarkPagePreview({ className, children }: { className?: string; children?: ReactNode }) {
  const { config } = useDarkPages()
  const filter = [
    config.brightness !== 100 && `brightness(${config.brightness / 100})`,
    config.contrast !== 100 && `contrast(${config.contrast / 100})`,
    config.warmth !== 0 && `sepia(${config.warmth / 100})`,
  ].filter(Boolean).join(' ') || 'none'
  return (
    <div
      aria-hidden="true"
      className={cn('overflow-hidden rounded-lg border border-border shadow-sm select-none', className)}
      style={{ filter, background: '#121212', transition: 'filter 120ms linear' }}
    >
      {/* The site's header, kept as the site coloured it. */}
      <div className="flex h-7 items-center gap-2 px-3" style={{ background: '#1a4f9c' }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#ffffff' }} />
        <span className="h-1.5 w-16 rounded-full" style={{ background: '#e8eefb' }} />
        <span className="ml-auto h-4 w-12 rounded" style={{ background: '#2f6bd1' }} />
      </div>
      <div className="flex gap-3 p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="h-2.5 w-3/4 rounded-full" style={{ background: '#f2f2f2' }} />
          <span className="h-1.5 w-full rounded-full" style={{ background: '#c9c9c9' }} />
          <span className="h-1.5 w-11/12 rounded-full" style={{ background: '#c9c9c9' }} />
          <span className="h-1.5 w-4/5 rounded-full" style={{ background: '#c9c9c9' }} />
          <span className="h-1.5 w-1/2 rounded-full" style={{ background: '#8ab4f8' }} />
          <div className="mt-1 rounded-md p-2" style={{ background: '#1f2021', border: '1px solid #333536' }}>
            <span className="block h-1.5 w-2/3 rounded-full" style={{ background: '#b9b9b9' }} />
            <span className="mt-1.5 block h-1.5 w-1/2 rounded-full" style={{ background: '#9a9a9a' }} />
          </div>
        </div>
        {/* A photo: pictures keep their colours. */}
        <div
          className="h-[74px] w-[92px] shrink-0 rounded-md"
          style={{ background: 'linear-gradient(160deg, #6fb6ff 0%, #9fd0ff 45%, #f4c06a 46%, #e59a3c 60%, #3f7d3a 61%, #2c5e2a 100%)' }}
        />
      </div>
      {children}
    </div>
  )
}
