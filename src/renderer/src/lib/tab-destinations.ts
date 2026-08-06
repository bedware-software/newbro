import type { PickerItem } from '../components/PickerDialog'
import type { Profile } from '../store/types'

/** Shared vocabulary for the "pick a container for this tab" pickers
 *  (MoveCopyTabDialog, OpenExternalLinkDialog). Keeping the encoding and the
 *  item construction in one place is what makes those dialogs read and behave
 *  identically — the wording of a Root row is a UI decision that should never
 *  drift between them. */

/** Encodes a (workspaceId, groupId|null) pair into a single picker item id.
 *  Null group means "Root" — the workspace's ungrouped surface. */
export function encodeTarget(workspaceId: string, groupId: string | null): string {
  return `${workspaceId}::${groupId ?? '__root__'}`
}

export function decodeTarget(id: string): { workspaceId: string; groupId: string | null } {
  const [workspaceId, groupKey] = id.split('::')
  return { workspaceId, groupId: groupKey === '__root__' ? null : groupKey }
}

/** Build the destination list. Each workspace contributes one Root item plus
 *  one item per tab group. Items are tagged with a section header so the
 *  PickerDialog can group them by "Profile / Workspace". */
export function buildDestinationItems(
  profiles: Profile[],
  scope: 'current' | 'all',
  currentWorkspaceId: string | null,
): PickerItem[] {
  const out: PickerItem[] = []
  for (const p of profiles) {
    for (const w of p.workspaces) {
      if (scope === 'current' && w.id !== currentWorkspaceId) continue
      const section = `Profile: ${p.name} · Workspace: ${w.name}`
      // Root entry — kept first so it always anchors each workspace's group.
      // Label is the workspace name with a trailing slash (a path-like "top of
      // this workspace") because plain "Root" is ambiguous when results span
      // multiple workspaces.
      out.push({
        id: encodeTarget(w.id, null),
        label: `${w.name}/`,
        subLabel: `Top level in the ${w.name} workspace`,
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
