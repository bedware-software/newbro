interface Props {
  /** On while the list is narrowed to where the user is (this workspace or
   *  profile); off while it spans everything. */
  on: boolean
  /** What the switch reads in its current position, e.g. "All workspaces". */
  label: string
  onToggle: () => void
  title?: string
  /** Placement classes from the host row (e.g. `ml-auto`). */
  className?: string
}

/** The scope switch shared by the search window and the pickers, so both
 *  read and behave alike. Tab flips it in both places; each window handles
 *  that key itself, the ⇥ here only advertises it. */
export function ScopeSwitch({ on, label, onToggle, title, className = '' }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      role="switch"
      aria-checked={on}
      className={`flex items-center gap-1.5 h-6 px-2 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      {label}
      <span
        className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          on ? 'bg-primary' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${
            on ? 'translate-x-[10px]' : 'translate-x-0'
          }`}
        />
      </span>
      <span className="opacity-50">⇥</span>
    </button>
  )
}
