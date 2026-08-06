import { useMemo, useState, useEffect } from 'react'
import { useAppStore, saveStateNow } from '../store/app-store'
import { buildDestinationItems, decodeTarget, encodeTarget } from '../lib/tab-destinations'
import { PickerDialog } from './PickerDialog'

interface Props {
  open: boolean
  /** 'move' rewrites each source tab's parent; 'copy' clones each one. */
  mode: 'move' | 'copy'
  /** Tabs whose destination is being chosen. A single-tab call (keyboard
   *  shortcut, or right-click on an unselected tab) passes a one-element
   *  array; multi-tab calls (right-click on a selected tab while more
   *  are selected) pass the full set. Empty while the dialog closes —
   *  the dialog renders nothing when open is false anyway. */
  tabIds: string[]
  /** The workspace the user is currently looking at — used by the default
   *  scope toggle to limit destinations to "this workspace". */
  currentWorkspaceId: string | null
  onClose: () => void
}

export function MoveCopyTabDialog({ open, mode, tabIds, currentWorkspaceId, onClose }: Props) {
  const profiles = useAppStore((s) => s.profiles)
  const moveTabAcross = useAppStore((s) => s.moveTabAcross)
  const copyTabAcross = useAppStore((s) => s.copyTabAcross)
  const [scope, setScope] = useState<'current' | 'all'>('current')

  // Reset scope when the dialog (re)opens so each invocation starts at the
  // documented default rather than carrying the previous session's choice.
  useEffect(() => {
    if (open) setScope('current')
  }, [open])

  const isMulti = tabIds.length > 1

  // Snapshot the source tabs' metadata so the subtitle and self-exclusion
  // logic stay correct even if state shifts under us mid-dialog. Each
  // entry preserves the lookup needed to short-circuit a no-op move
  // (target == current container).
  const tabs = useMemo(() => {
    const out: { tab: { id: string; title: string; url: string }; workspaceId: string; groupId: string | null }[] = []
    for (const id of tabIds) {
      let found = false
      for (const p of profiles) {
        for (const w of p.workspaces) {
          const ut = w.tabs?.find((t) => t.id === id)
          if (ut) {
            out.push({ tab: ut, workspaceId: w.id, groupId: null })
            found = true
            break
          }
          for (const g of w.tabGroups) {
            const t = g.tabs.find((t) => t.id === id)
            if (t) {
              out.push({ tab: t, workspaceId: w.id, groupId: g.id })
              found = true
              break
            }
          }
          if (found) break
        }
        if (found) break
      }
    }
    return out
  }, [tabIds, profiles])

  const items = useMemo(() => {
    const all = buildDestinationItems(profiles, scope, currentWorkspaceId)
    if (mode !== 'move' || tabs.length === 0) return all
    // For "Move" we hide containers that are already the source for ALL
    // selected tabs — moving each tab there would be a per-tab no-op.
    // When the selection spans multiple containers, every destination is
    // a meaningful target for at least one tab, so the filter doesn't
    // exclude anything. Copy keeps every option (a user might genuinely
    // want a duplicate next to the original).
    const sourceIds = new Set(tabs.map((t) => encodeTarget(t.workspaceId, t.groupId)))
    if (sourceIds.size !== 1) return all
    const onlySource = sourceIds.values().next().value
    return all.filter((item) => item.id !== onlySource)
  }, [profiles, scope, currentWorkspaceId, mode, tabs])

  const verb = mode === 'move' ? 'Move' : 'Copy'
  const verbing = mode === 'move' ? 'Moving' : 'Copying'

  // Default confirm opens (and focuses) the destination workspace window and
  // activates the moved/copied tab, so the user follows it to its new home.
  // Holding Shift (`background`) skips that — the tab is relocated silently and
  // the current window keeps focus.
  const handleConfirm = async (itemId: string, { background }: { background: boolean }): Promise<void> => {
    if (tabIds.length === 0) return
    const { workspaceId, groupId } = decodeTarget(itemId)

    // Relocate every tab; remember the first resulting tab id to activate in
    // the destination. Move preserves ids, copy mints new ones.
    let targetTabId: string | null = null
    for (const id of tabIds) {
      if (mode === 'move') {
        moveTabAcross(id, workspaceId, groupId)
        if (targetTabId === null) targetTabId = id
      } else {
        const newId = copyTabAcross(id, workspaceId, groupId)
        if (targetTabId === null) targetTabId = newId
      }
    }

    if (!background) {
      // Resolve the destination's profile + name to open its window.
      let destProfileId: string | null = null
      let destWorkspaceName = ''
      for (const p of profiles) {
        const w = p.workspaces.find((w) => w.id === workspaceId)
        if (w) { destProfileId = p.id; destWorkspaceName = w.name; break }
      }
      if (destProfileId) {
        // Persist first so a not-yet-open / background destination window has
        // the relocated tab in its state before it's asked to activate it.
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

  const titleSuffix = isMulti ? `${tabIds.length} Tabs` : 'Tab'
  const subtitle = isMulti
    ? (
      <>
        {verbing} <span className="text-foreground font-medium">{tabIds.length} tabs</span>
      </>
    )
    : tabs[0] ? (
      <>
        {verbing} <span className="text-foreground font-medium">{tabs[0].tab.title || tabs[0].tab.url}</span>
      </>
    ) : undefined

  return (
    <PickerDialog
      open={open}
      title={`${verb} ${titleSuffix}`}
      windowTitle={`${verb} ${titleSuffix} - Newbro`}
      placeholder={isMulti ? `${verb} tabs to…` : `${verb} tab to…`}
      subtitle={subtitle}
      items={items}
      emptyMessage="No destinations available"
      confirmVerb={verb}
      backgroundHint="In background"
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
