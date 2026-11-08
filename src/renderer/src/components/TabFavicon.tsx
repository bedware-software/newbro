import { useEffect, useState } from 'react'
import { Globe, Download, CircleAlert, Zap, type LucideIcon } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import { internalIconName } from '../lib/internal-pages'

// Icons for internal pages (vimperium://…), keyed by the name after the
// favicon marker — see lib/internal-pages.ts.
const INTERNAL_ICONS: Record<string, LucideIcon> = {
  download: Download,
  zap: Zap,
  alert: CircleAlert,
}

interface Props {
  favicon?: string
  className?: string
  globeSize?: number
}

/**
 * Renders a tab's favicon as an <img>, falling back to a globe icon when
 * the favicon URL is empty OR fails to load (e.g. dead site, stale data URI).
 *
 * The `broken` state is reset whenever:
 *   1. The `favicon` URL prop changes (covers normal navigation)
 *   2. The set of user-bypassed cert origins changes (covers the case where
 *      the image failed at startup due to an invalid cert, then the user
 *      clicks through the warning — the URL doesn't change, so we need a
 *      separate trigger to retry the load)
 */
export function TabFavicon({
  favicon,
  className = 'w-4 h-4 shrink-0 rounded-sm',
  globeSize = 14,
}: Props) {
  const [broken, setBroken] = useState(false)
  const certBypassedOrigins = useAppStore((s) => s.certBypassedOrigins)
  useEffect(() => { setBroken(false) }, [favicon, certBypassedOrigins])

  // Both the vimperium-icon: marker and the newbro-icon: one tabs saved
  // before the rename still carry.
  const iconName = internalIconName(favicon)
  if (iconName !== null) {
    const Icon = INTERNAL_ICONS[iconName] ?? Globe
    return <Icon size={globeSize} className="shrink-0 text-muted-foreground" />
  }
  if (!favicon || broken) {
    return <Globe size={globeSize} className="shrink-0 text-muted-foreground" />
  }
  return (
    <img
      key={favicon}
      src={favicon}
      className={className}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
    />
  )
}
