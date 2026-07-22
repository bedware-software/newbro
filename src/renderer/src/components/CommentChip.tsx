interface Props {
  comment: string
}

/** Compact inline-code treatment for a tab's user-authored comment. */
export function CommentChip({ comment }: Props) {
  return (
    <span
      className="block min-w-0 max-w-[45%] shrink-0 truncate rounded-sm bg-secondary px-1 font-mono text-[10px] leading-4 text-muted-foreground ring-1 ring-inset ring-foreground/10"
      title={comment}
      aria-label={`Comment: ${comment}`}
    >
      {comment}
    </span>
  )
}
