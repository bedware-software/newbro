import { useEffect, useMemo, useState } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import type { PickerItem } from './PickerDialog'
import { PickerDialog } from './PickerDialog'

interface Props {
  open: boolean
  /** 'move' rehomes the source group; 'copy' clones it (group + every tab). */
  mode: 'move' | 'copy'
  /** Group whose destination is being chosen. */
  groupId: string | null
  /** Profile of the source — used by the default scope toggle to limit
   *  destinations to "workspaces in this profile". Null means "no current
   *  profile context", in which case the default-scope filter is a no-op
   *  and all profiles' workspaces appear. */
  currentProfileId: string | null
  onClose: () => void
}

/** Build the destination list. Each profile's workspaces become items;
 *  the source group's own workspace is excluded so the picker always
 *  represents a real change of home. */
function buildItems(
  profiles: ReturnType<typeof useAppStore.getState>['profiles'],
  scope: 'current' | 'all',
  currentProfileId: string | null,
  excludeWorkspaceId: string | null,
): PickerItem[] {
  const out: PickerItem[] = []
  for (const p of profiles) {
    if (scope === 'current' && currentProfileId && p.id !== currentProfileId) continue
    for (const w of p.workspaces) {
      if (w.id === excludeWorkspaceId) continue
      const tabCount =
        (w.tabs?.length ?? 0) +
        w.tabGroups.reduce((acc, g) => acc + g.tabs.length, 0)
      out.push({
        id: w.id,
        label: w.name,
        section: `Profile: ${p.name}`,
        trailingNote: `${tabCount} tabs`,
      })
    }
  }
  return out
}

export function MoveCopyGroupDialog({ open, mode, groupId, currentProfileId, onClose }: Props) {
  const profiles = useAppStore((s) => s.profiles)
  const moveGroupAcross = useAppStore((s) => s.moveGroupAcross)
  const copyGroupAcross = useAppStore((s) => s.copyGroupAcross)
  const [scope, setScope] = useState<'current' | 'all'>('current')

  useEffect(() => {
    if (open) setScope('current')
  }, [open])

  // Snapshot of the source group plus the workspace that owns it. Used to
  // exclude the source workspace from the destination list and to surface
  // the group's name in the dialog subtitle.
  const sourceInfo = useMemo(() => {
    if (!groupId) return null
    for (const p of profiles) {
      for (const w of p.workspaces) {
        const g = w.tabGroups.find((g) => g.id === groupId)
        if (g) return { group: g, workspaceId: w.id, profileId: p.id }
      }
    }
    return null
  }, [groupId, profiles])

  const items = useMemo(
    () => buildItems(profiles, scope, currentProfileId, sourceInfo?.workspaceId ?? null),
    [profiles, scope, currentProfileId, sourceInfo],
  )

  const verb = mode === 'move' ? 'Move' : 'Copy'
  const verbing = mode === 'move' ? 'Moving' : 'Copying'

  // Default confirm opens (and focuses) the destination workspace window and
  // activates the group's first tab, so the user follows the group to its new
  // home. Holding Shift (`background`) relocates it silently and keeps focus
  // on the current window.
  const handleConfirm = async (workspaceId: string, { background }: { background: boolean }): Promise<void> => {
    if (!groupId) return

    let targetTabId: string | null = null
    if (mode === 'move') {
      moveGroupAcross(groupId, workspaceId)
      // Move preserves tab ids, so the snapshot's first tab is the one to focus.
      targetTabId = sourceInfo?.group.tabs[0]?.id ?? null
    } else {
      targetTabId = copyGroupAcross(groupId, workspaceId)
    }

    if (!background) {
      let destProfileId: string | null = null
      let destWorkspaceName = ''
      for (const p of profiles) {
        const w = p.workspaces.find((w) => w.id === workspaceId)
        if (w) { destProfileId = p.id; destWorkspaceName = w.name; break }
      }
      if (destProfileId) {
        // Persist first so a not-yet-open destination window has the relocated
        // group in its state before it's asked to activate the tab.
        await saveStateNow()
        void window.electronAPI.openWorkspaceWindow(
          destProfileId,
          workspaceId,
          destWorkspaceName,
          targetTabId ?? undefined,
        )
      }
    }
    onClose()
  }

  const subtitle = sourceInfo ? (
    <>
      {verbing} group <span className="text-foreground font-medium">{sourceInfo.group.name}</span>
    </>
  ) : undefined

  return (
    <PickerDialog
      open={open}
      title={`${verb} Group`}
      windowTitle={`${verb} Group - Newbro`}
      placeholder={`${verb} group to workspace…`}
      subtitle={subtitle}
      items={items}
      emptyMessage="No other workspaces available"
      confirmVerb={verb}
      backgroundHint="In background"
      scope={scope}
      onScopeChange={setScope}
      scopeChoices={[
        { value: 'current', label: 'Current Profile' },
        { value: 'all', label: 'Any Profile' },
      ]}
      onConfirm={handleConfirm}
      onCancel={onClose}
    />
  )
}
