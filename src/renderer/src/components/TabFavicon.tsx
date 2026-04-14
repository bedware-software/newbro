import { useState } from 'react'
import { Globe } from 'lucide-react'

interface Props {
  favicon?: string
  className?: string
  globeSize?: number
}

/**
 * Renders a tab's favicon as an <img>, falling back to a globe icon when
 * the favicon URL is empty OR fails to load (e.g. dead site, stale data URI).
 * The broken state is reset automatically when `favicon` changes (via key).
 */
export function TabFavicon({
  favicon,
  className = 'w-4 h-4 shrink-0 rounded-sm',
  globeSize = 14,
}: Props) {
  const [broken, setBroken] = useState(false)
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
