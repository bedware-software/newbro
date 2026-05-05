import { useMemo, useState, useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import type { PickerItem } from './PickerDialog'
import { PickerDialog } from './PickerDialog'

interface Props {
  open: boolean
  /** 'move' rewrites the source tab's parent; 'copy' clones it. */
  mode: 'move' | 'copy'
  /** Tab whose destination is being chosen. May be null while the dialog
   *  closes — the dialog renders nothing when open is false anyway. */
  tabId: string | null
  /** The workspace the user is currently looking at — used by the default
   *  scope toggle to limit destinations to "this workspace". */
  currentWorkspaceId: string | null
  onClose: () => void
}

/** Encodes a (workspaceId, groupId|null) pair into a single picker item id.
 *  Null group means "Root" (the workspace's ungrouped surface). */
function encodeTarget(workspaceId: string, groupId: string | null): string {
  return `${workspaceId}::${groupId ?? '__root__'}`
}

function decodeTarget(id: string): { workspaceId: string; groupId: string | null } {
  const [workspaceId, groupKey] = id.split('::')
  return { workspaceId, groupId: groupKey === '__root__' ? null : groupKey }
}

/** Build the destination list. Each workspace contributes one Root item plus
 *  one item per tab group. Items are tagged with a section header so the
 *  PickerDialog can group them by "Profile / Workspace". */
function buildItems(
  profiles: ReturnType<typeof useAppStore.getState>['profiles'],
  scope: 'current' | 'all',
  currentWorkspaceId: string | null,
): PickerItem[] {
  const out: PickerItem[] = []
  for (const p of profiles) {
    for (const w of p.workspaces) {
      if (scope === 'current' && w.id !== currentWorkspaceId) continue
      const section = scope === 'current' ? `${p.name} · ${w.name}` : `${p.name} · ${w.name}`
      // Root entry — kept first so it always anchors each workspace's group.
      out.push({
        id: encodeTarget(w.id, null),
        label: 'Root',
        subLabel: 'Ungrouped tabs',
        section,
        trailingNote: `${(w.tabs || []).length} tabs`,
      })
      for (const g of w.tabGroups) {
        out.push({
          id: encodeTarget(w.id, g.id),
          label: g.name,
          color: g.color,
          section,
          trailingNote: `${g.tabs.length} tabs`,
        })
      }
    }
  }
  return out
}

export function MoveCopyTabDialog({ open, mode, tabId, currentWorkspaceId, onClose }: Props) {
  const profiles = useAppStore((s) => s.profiles)
  const moveTabAcross = useAppStore((s) => s.moveTabAcross)
  const copyTabAcross = useAppStore((s) => s.copyTabAcross)
  const [scope, setScope] = useState<'current' | 'all'>('current')

  // Reset scope when the dialog (re)opens so each invocation starts at the
  // documented default rather than carrying the previous session's choice.
  useEffect(() => {
    if (open) setScope('current')
  }, [open])

  // Snapshot the source tab's metadata so the subtitle and self-exclusion
  // logic stay correct even if state shifts under us mid-dialog.
  const tab = useMemo(() => {
    if (!tabId) return null
    for (const p of profiles) {
      for (const w of p.workspaces) {
        const ut = w.tabs?.find((t) => t.id === tabId)
        if (ut) return { tab: ut, workspaceId: w.id, groupId: null as string | null }
        for (const g of w.tabGroups) {
          const t = g.tabs.find((t) => t.id === tabId)
          if (t) return { tab: t, workspaceId: w.id, groupId: g.id }
        }
      }
    }
    return null
  }, [tabId, profiles])

  const items = useMemo(() => {
    const all = buildItems(profiles, scope, currentWorkspaceId)
    if (mode !== 'move' || !tab) return all
    // For "Move" we hide the tab's CURRENT container — moving to where it
    // already lives is a no-op and clutters the list. Copy keeps every
    // option (a user might genuinely want a duplicate next to the original).
    const selfId = encodeTarget(tab.workspaceId, tab.groupId)
    return all.filter((item) => item.id !== selfId)
  }, [profiles, scope, currentWorkspaceId, mode, tab])

  const verb = mode === 'move' ? 'Move' : 'Copy'
  const verbing = mode === 'move' ? 'Moving' : 'Copying'

  const handleConfirm = (itemId: string): void => {
    if (!tabId) return
    const { workspaceId, groupId } = decodeTarget(itemId)
    if (mode === 'move') moveTabAcross(tabId, workspaceId, groupId)
    else copyTabAcross(tabId, workspaceId, groupId)
    onClose()
  }

  const subtitle = tab ? (
    <>
      {verbing} <span className="text-foreground font-medium">{tab.tab.title || tab.tab.url}</span>
    </>
  ) : undefined

  return (
    <PickerDialog
      open={open}
      title={`${verb} Tab`}
      windowTitle={`${verb} Tab - Newbro`}
      placeholder={`${verb} tab to…`}
      subtitle={subtitle}
      items={items}
      emptyMessage="No destinations available"
      confirmVerb={verb}
      scope={scope}
      onScopeChange={setScope}
      scopeChoices={[
        { value: 'current', label: 'Current Workspace' },
        { value: 'all', label: 'Any Workspace' },
      ]}
      onConfirm={handleConfirm}
      onCancel={onClose}
    />
  )
}
