import { useMemo, useState, useEffect } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import type { PickerItem } from './PickerDialog'
import { PickerDialog } from './PickerDialog'

interface Props {
  open: boolean
  /** The URL handed off by the OS (or another app) that needs a home. */
  url: string | null
  /** Workspace the user was last looking at in this window — used to seed
   *  the default destination and the initial scope. */
  currentWorkspaceId: string | null
  onClose: () => void
}

/** Same encoding scheme as MoveCopyTabDialog so the two pickers stay
 *  visually and behaviourally consistent. `__root__` means "the workspace's
 *  ungrouped surface" (i.e. addUngroupedTab). */
function encodeTarget(workspaceId: string, groupId: string | null): string {
  return `${workspaceId}::${groupId ?? '__root__'}`
}

function decodeTarget(id: string): { workspaceId: string; groupId: string | null } {
  const [workspaceId, groupKey] = id.split('::')
  return { workspaceId, groupId: groupKey === '__root__' ? null : groupKey }
}

function buildItems(
  profiles: ReturnType<typeof useAppStore.getState>['profiles'],
  scope: 'current' | 'all',
  currentWorkspaceId: string | null,
): PickerItem[] {
  const out: PickerItem[] = []
  for (const p of profiles) {
    for (const w of p.workspaces) {
      if (scope === 'current' && w.id !== currentWorkspaceId) continue
      const section = `Profile: ${p.name} · Workspace: ${w.name}`
      out.push({
        id: encodeTarget(w.id, null),
        label: `Root · ${w.name}`,
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

export function OpenExternalLinkDialog({ open, url, currentWorkspaceId, onClose }: Props) {
  const profiles = useAppStore((s) => s.profiles)
  const addTab = useAppStore((s) => s.addTab)
  const addUngroupedTab = useAppStore((s) => s.addUngroupedTab)
  const activeTabGroupId = useAppStore((s) => s.activeTabGroupId)
  const [scope, setScope] = useState<'current' | 'all'>('current')

  // Reset scope on each (re)open so the user always starts in the workspace
  // the link was routed to — mirrors MoveCopyTabDialog's behavior.
  useEffect(() => {
    if (open) setScope('current')
  }, [open])

  // Default destination: the active tab group in the routed workspace, or
  // its Root if no group is active. Captured per-open so a late state shift
  // can't move the highlight under the user.
  const initialItemId = useMemo(() => {
    if (!open || !currentWorkspaceId) return undefined
    // Verify the active group actually lives in this workspace before
    // anchoring to it — the active-group pointer is global state and can
    // briefly point at a group from a different workspace during switches.
    for (const p of profiles) {
      const w = p.workspaces.find((w) => w.id === currentWorkspaceId)
      if (!w) continue
      if (activeTabGroupId && w.tabGroups.some((g) => g.id === activeTabGroupId)) {
        return encodeTarget(currentWorkspaceId, activeTabGroupId)
      }
      return encodeTarget(currentWorkspaceId, null)
    }
    return undefined
  }, [open, currentWorkspaceId, activeTabGroupId, profiles])

  const items = useMemo(
    () => buildItems(profiles, scope, currentWorkspaceId),
    [profiles, scope, currentWorkspaceId],
  )

  const handleConfirm = async (itemId: string): Promise<void> => {
    if (!url) return
    const { workspaceId, groupId } = decodeTarget(itemId)

    // Resolve the destination workspace's profile + name so we can route
    // the new tab to its window.
    let destProfileId: string | null = null
    let destWorkspaceName = ''
    for (const p of profiles) {
      const w = p.workspaces.find((w) => w.id === workspaceId)
      if (w) { destProfileId = p.id; destWorkspaceName = w.name; break }
    }

    // A link handed off from another app must ALWAYS land focused — that's
    // the whole point of routing it here. The destination can be a workspace
    // other than the one this window is showing, so we mirror SearchDialog's
    // cross-window handoff: create the tab, then ask the destination
    // workspace's window to surface + activate it.
    const sameWindow = workspaceId === currentWorkspaceId
    // For the current window, activate immediately so there's no flicker.
    // For another window, add it in the background here (don't disturb this
    // window's active tab) — the target window does the activating.
    const newTabId = groupId
      ? addTab(groupId, url, sameWindow)
      : addUngroupedTab(workspaceId, url, sameWindow)

    if (destProfileId) {
      // Persist first so a not-yet-open or background destination window has
      // the new tab in its state before it's asked to activate it (the save
      // broadcasts `state:updated` to other windows).
      if (!sameWindow) await saveStateNow()
      // For the current window this just re-focuses it (raising it back to
      // the foreground after the picker popup closes); the tab is already
      // active. For another workspace it opens/focuses that window and
      // activates the new tab via its id.
      void window.electronAPI.openWorkspaceWindow(
        destProfileId,
        workspaceId,
        destWorkspaceName,
        sameWindow ? undefined : newTabId,
      )
    }
    onClose()
  }

  const subtitle = url ? (
    <>
      Opening <span className="text-foreground font-medium">{url}</span>
    </>
  ) : undefined

  return (
    <PickerDialog
      open={open}
      title="Open Link"
      windowTitle="Open Link - Newbro"
      placeholder="Open link in…"
      subtitle={subtitle}
      items={items}
      emptyMessage="No destinations available"
      confirmVerb="Open"
      initialItemId={initialItemId}
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
