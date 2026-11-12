import { useEffect, useId, useRef, useState } from 'react'

interface Props {
  /** Bumped to glitch the mark once more. */
  glitchKey?: number
  /** 'full': the whole badge, the blades on their chamfered plate, as the
   *  app icon is drawn — the toolbar's Menu button, Settings → About.
   *  'small': the blades alone, the drawing the icon's smallest sizes use. */
  variant?: 'full' | 'small'
  /** Glitch as the pointer comes onto the mark too. */
  glitchOnHover?: boolean
  /** Its side in px. Without it the full badge fills its box and the small
   *  one is 18 px. */
  size?: number
}

/** The app's mark — two katanas crossed point-down into a V, the guards on
 *  top — in the app icon's colours, the same whatever Vim's mode or the
 *  theme. A glitch (glitchKey bumped, or the pointer coming onto it with
 *  glitchOnHover) tears it: three copies of it, the two behind in the
 *  second trio and in the mark's second colour alone, cut into bands that
 *  jump sideways for half a second (.brand-mark in globals.css). Still
 *  where Settings → Appearance → Motion says so (lib/motion.ts), and while
 *  its window isn't the one in use. */
export function BrandMark({ glitchKey = 0, variant = 'small', glitchOnHover = false, size }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const first = useRef(true)
  const [hovers, setHovers] = useState(0)
  // Every copy of the badge needs ids of its own: a gradient takes its
  // colours from where it is defined, so copies pointing at copy 1's
  // gradients would paint in copy 1's colours.
  const uid = `bm${useId().replace(/[^\w-]/g, '')}`

  useEffect(() => {
    if (first.current) { first.current = false; return }
    const el = ref.current
    // The window the mark is drawn in: Settings → About is a window of its own.
    if (!el || el.ownerDocument.documentElement.hasAttribute('data-window-inactive')) return
    // Restart the animation even if the last burst is still running.
    el.removeAttribute('data-glitch')
    void el.offsetWidth
    el.setAttribute('data-glitch', '')
    const t = setTimeout(() => el.removeAttribute('data-glitch'), 600)
    return () => clearTimeout(t)
  }, [glitchKey, hovers])

  return (
    <span
      ref={ref}
      className="brand-mark"
      data-variant={variant}
      aria-hidden="true"
      style={size ? { width: size, height: size } : undefined}
      onPointerEnter={glitchOnHover ? () => setHovers((n) => n + 1) : undefined}
    >
      {[0, 1, 2].map((i) => (variant === 'full' ? <Badge key={i} id={`${uid}-${i}`} /> : <Katanas key={i} />))}
    </span>
  )
}

function Katanas() {
  return (
    <svg viewBox="0 0 64 64">
      <polygon points="53.38,17.3 35.36,50.27 27.81,55.58 28.83,47.23 42.51,12.23" fill="var(--c1)" />
      <polygon points="10.62,17.3 28.64,50.27 36.19,55.58 35.17,47.23 21.49,12.23" fill="var(--c1)" />
      <path
        d="M6.39,16.51L7.15,13.4L20.74,7.06L23.61,8.49L22.85,11.6L9.26,17.94Z M57.61,16.51L56.85,13.4L43.26,7.06L40.39,8.49L41.15,11.6L54.74,17.94Z"
        fill="var(--c3)"
      />
    </svg>
  )
}

// The full badge's parts, in its 64-unit box: a blade in its own frame (the
// guard at the origin, the point down at y 48), then the slash across the two.
const BLADE = '-5,1.6 -3.3,39.5 1.6,48 3,39.5 5,1.6'
const RIGHT_SWORD = 'matrix(-1 0 0 1 64 0) translate(15 14) rotate(-25)'
const LEFT_SWORD = 'translate(15 14) rotate(-25)'
const SLASH = '54,20 32.81,34.38 10,46 31.19,31.62'

/** A mode colour sunk into the plate's ground. */
function ink(colour: string, percent: number): string {
  return `color-mix(in oklch, var(${colour}) ${percent}%, var(--bg))`
}

/** The full badge — docs/branding/vimperium-logo-concepts/svg/
 *  blade-01-crossed-katana.svg, the app icon's drawing — with its colours
 *  left to the CSS variables (--c1..3, --hot, --bg) and its ids prefixed by
 *  `id`, one prefix per copy. */
function Badge({ id }: { id: string }) {
  const ref = (name: string): string => `${id}-${name}`
  const url = (name: string): string => `url(#${id}-${name})`
  return (
    <svg viewBox="0 0 64 64">
      <defs>
        <linearGradient id={ref('bl')} gradientUnits="userSpaceOnUse" x1="-4.5" y1="0" x2="4.5" y2="0">
          <stop offset="0" stopColor={ink('--c1', 64)} />
          <stop offset=".55" stopColor={ink('--c1', 44)} />
          <stop offset="1" stopColor={ink('--c1', 30)} />
        </linearGradient>
        <linearGradient id={ref('pl')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={ink('--c1', 20)} />
          <stop offset="1" stopColor={ink('--c2', 11)} />
        </linearGradient>
        <radialGradient id={ref('wash')} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="var(--c1)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--c1)" stopOpacity="0" />
        </radialGradient>
        <filter id={ref('gl')} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        {/* One sword: the blade with its lit edge and point, a glowing groove
            down it, notches by the guard, the hilt with its wraps and
            pommel, the guard across. */}
        <g id={ref('sw')}>
          <polygon points={BLADE} fill={url('bl')} />
          <polygon points="-5,1.6 -3.2,1.6 -1.7,39.5 -3.3,39.5" fill="var(--c3)" />
          <polygon points="-3.3,39.5 3,39.5 1.6,48" fill="var(--c3)" opacity=".72" />
          <path d="M1 5L-0.3 36.5" stroke="var(--c2)" strokeWidth="3.2" strokeLinecap="round" fill="none" opacity=".45" filter={url('gl')} />
          <path d="M1 5L-0.3 36.5" stroke="var(--c2)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          <path d="M-3.3 39.5L3 39.5" stroke={ink('--c1', 30)} strokeWidth="1.5" fill="none" />
          <g fill="var(--bg)" opacity=".8">
            <rect x="3" y="7" width="2.2" height="1.8" />
            <rect x="2.8" y="11" width="2.4" height="1.8" />
            <rect x="2.7" y="15" width="2.5" height="1.8" />
          </g>
          <polygon points="-2.7,-1.7 -2.7,-11.6 2.7,-11.6 2.7,-1.7" fill={ink('--c2', 42)} />
          <polygon points="0,-6.5 2.1,-4.6 0,-2.7 -2.1,-4.6" fill="var(--c2)" />
          <polygon points="0,-10.6 2.1,-8.7 0,-6.8 -2.1,-8.7" fill="var(--c2)" />
          <polygon points="-2.7,-11.6 -2.7,-12.8 -2,-13.6 2,-13.6 2.7,-12.8 2.7,-11.6" fill={ink('--c2', 70)} />
          <polygon points="-7.5,0 -5.8,-1.8 5.8,-1.8 7.5,0 5.8,1.8 -5.8,1.8" fill="var(--c3)" />
          <path d="M-5 0L5 0" stroke={ink('--c1', 35)} strokeWidth="1.5" fill="none" />
        </g>
      </defs>
      {/* The plate: chamfered, an inner frame, two corner cuts lit, readout ticks. */}
      <polygon points="10,4 54,4 61,11 61,55 54,62 10,62 3,55 3,11" fill={url('pl')} stroke={ink('--c1', 50)} strokeWidth="1.5" strokeLinejoin="round" />
      <polygon points="11.5,6.5 52.5,6.5 58.5,12.5 58.5,53.5 52.5,59.5 11.5,59.5 5.5,53.5 5.5,12.5" fill="none" stroke={ink('--c3', 32)} strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M54 4L61 11" stroke="var(--c3)" strokeWidth="1.5" opacity=".7" />
      <path d="M3 55L10 62" stroke="var(--c3)" strokeWidth="1.5" opacity=".7" />
      <g fill={ink('--c3', 60)}>
        <rect x="9" y="53.5" width="7" height="1.6" />
        <rect x="9" y="56.5" width="4" height="1.6" />
        <rect x="48" y="56.5" width="1.6" height="1.6" />
        <rect x="51" y="56.5" width="1.6" height="1.6" />
        <rect x="54" y="56.5" width="1.6" height="1.6" fill="var(--hot)" />
      </g>
      <rect x="10" y="30" width="44" height="34" fill={url('wash')} />
      {/* The right sword behind; the left in front, a dark outline parting them. */}
      <g transform={RIGHT_SWORD}>
        <polygon points={BLADE} fill="none" stroke="var(--bg)" strokeWidth="2.4" strokeLinejoin="round" />
      </g>
      <use href={`#${ref('sw')}`} transform={RIGHT_SWORD} />
      <g transform={LEFT_SWORD}>
        <polygon points={BLADE} fill="var(--bg)" stroke="var(--bg)" strokeWidth="2.6" strokeLinejoin="round" />
      </g>
      <use href={`#${ref('sw')}`} transform={LEFT_SWORD} />
      {/* The light slash across them. */}
      <polygon points={SLASH} fill="var(--hot)" opacity=".6" filter={url('gl')} />
      <polygon points={SLASH} fill="var(--hot)" />
      <polygon points="50.5,22.1 32.41,33.69 13.5,43.9 31.59,32.31" fill="var(--c3)" opacity=".9" />
      {/* The spark where the points cross: Vim's diamond. */}
      <circle cx="32" cy="50.4" r="5.5" fill="var(--hot)" opacity=".3" />
      <polygon points="32,47.7 34.7,50.4 32,53.1 29.3,50.4" fill="var(--hot)" />
      <polygon points="32,49.1 33.3,50.4 32,51.7 30.7,50.4" fill="var(--c3)" />
      <g fill="var(--hot)" opacity=".85">
        <polygon points="25,44.7 26.3,46 25,47.3 23.7,46" />
        <polygon points="39.6,46.1 40.7,47.2 39.6,48.3 38.5,47.2" />
        <polygon points="32,59 33.2,60.2 32,61.4 30.8,60.2" />
      </g>
    </svg>
  )
}
