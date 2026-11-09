// The address bar: the active tab's address, read-only. Every edit of the
// address happens in the address editor (components/UrlEditor.tsx), with the
// suggestions the address bar used to have (lib/use-address-suggestions.ts):
// a click here opens it — as do Cmd/Ctrl+L, its label in COMMAND, and ; —
// in the mode Settings gives a click (typing, by default).

import { openUrlEditor } from '../lib/url-editor'

interface Props {
  tabUrl: string
}

export function Omnibox({ tabUrl }: Props) {
  const shown = tabUrl === 'about:blank' ? '' : tabUrl
  return (
    <button
      id="url-bar"
      type="button"
      // A press opens the editor at once, not on the release.
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        openUrlEditor('click')
      }}
      // The keys' click (Enter or Space on it, a ; label) opens it too.
      onClick={(e) => { if (e.detail === 0) openUrlEditor('click') }}
      title="Edit the address"
      aria-label={shown ? `Address: ${shown}. Edit` : 'Enter URL or search'}
      className="flex-1 min-w-0 h-full px-2.5 bg-transparent border-none text-left text-sm outline-none cursor-text truncate"
    >
      {shown ? <span className="text-foreground">{shown}</span> : <span className="text-muted-foreground">Enter URL or search...</span>}
    </button>
  )
}
