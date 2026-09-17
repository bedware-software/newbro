import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/app-store'
import type { PickerItem } from './PickerDialog'
import { PickerDialog } from './PickerDialog'
import type { Reading, ReadingGroup } from './Bookshelf'

/** What's being moved: readings (to any shelf's group or ungrouped list) or
 *  one whole group (to another profile's shelf). */
export type BookshelfMoveTarget =
  | { kind: 'readings'; ids: string[] }
  | { kind: 'group'; id: string }

interface Props {
  open: boolean
  target: BookshelfMoveTarget | null
  /** Profile whose shelf the items are on. */
  profileId: string | null
  onMoved: () => void
  onClose: () => void
}

interface Shelf {
  readings: Reading[]
  groups: ReadingGroup[]
}

// Null group = the shelf's ungrouped list, the Bookshelf's counterpart of a
// workspace's Root.
function encodeTarget(profileId: string, groupId: string | null): string {
  return `${profileId}::${groupId ?? '__root__'}`
}

function decodeTarget(id: string): { profileId: string; groupId: string | null } {
  const [profileId, groupKey] = id.split('::')
  return { profileId, groupId: groupKey === '__root__' ? null : groupKey }
}

function countReadings(n: number): string {
  return `${n} ${n === 1 ? 'reading' : 'readings'}`
}

/** The Bookshelf's Move picker, built like the sidebar's Move Tab / Move Group
 *  ones. Every profile's shelf is a destination, so this is how readings get
 *  from one profile to another — Duplicate first to leave the originals. */
export function MoveBookshelfDialog({ open, target, profileId, onMoved, onClose }: Props) {
  const profiles = useAppStore((s) => s.profiles)
  const [shelves, setShelves] = useState<Record<string, Shelf>>({})
  const [scope, setScope] = useState<'current' | 'all'>('all')

  useEffect(() => {
    if (open) setScope('all')
  }, [open])

  // Other profiles' shelves aren't mirrored in this window, so read them all
  // fresh on every open. Keyed on the profile ids alone: `profiles` changes
  // with every tab update, which mustn't refetch.
  const profileIdsKey = profiles.map((p) => p.id).join('\n')
  useEffect(() => {
    if (!open) { setShelves({}); return }
    let active = true
    void Promise.all(
      profileIdsKey.split('\n').map(async (id) => [id, await window.electronAPI.bookshelfList?.(id)] as const),
    ).then((entries) => {
      if (!active) return
      const next: Record<string, Shelf> = {}
      for (const [id, shelf] of entries) {
        if (shelf) next[id] = { readings: shelf.readings || [], groups: shelf.groups || [] }
      }
      setShelves(next)
    })
    return () => { active = false }
  }, [open, profileIdsKey])

  const source = profileId ? shelves[profileId] : undefined
  const movingReadings = useMemo(() => {
    if (target?.kind !== 'readings' || !source) return []
    const ids = new Set(target.ids)
    return source.readings.filter((r) => ids.has(r.id))
  }, [target, source])
  const movingGroup = target?.kind === 'group' ? source?.groups.find((g) => g.id === target.id) : undefined

  const items = useMemo(() => {
    const out: PickerItem[] = []
    if (!target) return out
    if (target.kind === 'group') {
      // Groups don't nest, so a group can only change shelves.
      for (const p of profiles) {
        const shelf = shelves[p.id]
        if (!shelf || p.id === profileId) continue
        out.push({ id: encodeTarget(p.id, null), label: p.name, trailingNote: `${shelf.groups.length} groups` })
      }
      return out
    }
    for (const p of profiles) {
      const shelf = shelves[p.id]
      if (!shelf || (scope === 'current' && p.id !== profileId)) continue
      const ungrouped = shelf.readings.filter((r) => r.status === 'toread' && !r.groupId).length
      out.push({
        id: encodeTarget(p.id, null),
        label: p.name,
        path: [{ label: p.name }],
        trailingNote: countReadings(ungrouped),
      })
      for (const g of shelf.groups) {
        out.push({
          id: encodeTarget(p.id, g.id),
          label: g.name,
          color: g.color,
          path: [{ label: p.name }, { label: g.name, pill: true }],
          trailingNote: countReadings(shelf.readings.filter((r) => r.groupId === g.id).length),
        })
      }
    }
    // Hide the one place every reading already sits — moving there is a no-op.
    const sourceIds = new Set(movingReadings.map((r) => encodeTarget(profileId ?? '', r.groupId ?? null)))
    if (sourceIds.size !== 1) return out
    const [onlySource] = sourceIds
    return out.filter((item) => item.id !== onlySource)
  }, [target, profiles, shelves, scope, profileId, movingReadings])

  const handleConfirm = async (itemId: string): Promise<void> => {
    if (!target || !profileId) return
    const { profileId: toProfileId, groupId } = decodeTarget(itemId)
    const ids = target.kind === 'group' ? [target.id] : target.ids
    await window.electronAPI.bookshelfMove?.(profileId, ids, toProfileId, groupId)
    onMoved()
    onClose()
  }

  const isGroup = target?.kind === 'group'
  const count = target?.kind === 'readings' ? target.ids.length : 0
  const title = isGroup ? 'Move Group' : count > 1 ? `Move ${count} Readings` : 'Move Reading'
  const what = isGroup
    ? movingGroup?.name
    : count > 1 ? countReadings(count) : movingReadings[0]?.title || movingReadings[0]?.url

  return (
    <PickerDialog
      // Wait for the shelves so the list doesn't flash its empty message.
      open={open && !!target && !!source}
      title={title}
      windowTitle={`${title} - Newbro`}
      placeholder={isGroup ? 'Move group to profile…' : 'Move to…'}
      subtitle={what ? <>Moving <span className="text-foreground font-medium">{what}</span></> : undefined}
      items={items}
      emptyMessage={isGroup ? 'No other profiles available' : 'No destinations available'}
      confirmVerb="Move"
      {...(isGroup ? {} : {
        scope,
        onScopeChange: setScope,
        scopeLabels: { current: 'This profile', all: 'All profiles' },
      })}
      onConfirm={(id) => { void handleConfirm(id) }}
      onCancel={onClose}
    />
  )
}
