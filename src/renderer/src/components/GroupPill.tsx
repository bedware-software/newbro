interface Props {
  name: string
  /** Layout classes for where the pill sits (e.g. truncation in a row label). */
  className?: string
  title?: string
}

/**
 * A tab group's name drawn in the group's own colours, the way the sidebar's
 * group header shows it. Fill and ink come from `[data-group-pill]` in
 * globals.css, so an ancestor must carry `data-group-container` with the
 * group's hex as `--gc`. The search and picker windows name a group through
 * this both in a row's label and in its breadcrumb, so the two always match.
 */
export function GroupPill({ name, className = '', title }: Props) {
  return (
    <span data-group-pill="" className={`rounded-sm px-1 font-medium ${className}`} title={title}>
      {name}
    </span>
  )
}
