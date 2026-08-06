import type { PickerItem, PickerPathSegment } from '../components/PickerDialog'
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
 *  one item per tab group. Every row carries its own full
 *  "Profile / Workspace / Group" path (the same breadcrumb the search window
 *  shows), which is why there are no section headers here — the path already
 *  says where each destination lives, and a header would only repeat it. */
export function buildDestinationItems(
  profiles: Profile[],
  scope: 'current' | 'all',
  currentWorkspaceId: string | null,
): PickerItem[] {
  const out: PickerItem[] = []
  for (const p of profiles) {
    for (const w of p.workspaces) {
      if (scope === 'current' && w.id !== currentWorkspaceId) continue
      const workspacePath: PickerPathSegment[] = [{ label: p.name }, { label: w.name }]
      // Root entry — kept first so it always anchors each workspace's block.
      // Labelled with the plain workspace name: its path has no group pill,
      // which is what distinguishes "the workspace itself" from a group inside
      // it (plain "Root" is ambiguous when results span multiple workspaces).
      out.push({
        id: encodeTarget(w.id, null),
        label: w.name,
        path: workspacePath,
        trailingNote: `${(w.tabs || []).length} tabs`,
      })
      for (const g of w.tabGroups) {
        out.push({
          id: encodeTarget(w.id, g.id),
          label: g.name,
          color: g.color,
          // The group crumb repeats the label, but as the colored pill — it's
          // what ties the row to the group's identity in the sidebar.
          path: [...workspacePath, { label: g.name, pill: true }],
          trailingNote: `${g.tabs.length} tabs`,
        })
      }
    }
  }
  return out
}
