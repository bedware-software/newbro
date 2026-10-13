// What the address bar shows while the address editor has the address
// (UrlEditor.tsx): how much is open — here, in this profile, everywhere.

import { Globe, Layout, User } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import type { Workspace } from '../store/types'

function tabCount(w: Workspace): number {
  return (w.tabs?.length ?? 0) + w.tabGroups.reduce((n, g) => n + g.tabs.length, 0)
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function WorkspaceStats() {
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const profile = profiles.find((p) => p.id === activeProfileId)
  const workspace = profile?.workspaces.find((w) => w.id === activeWorkspaceId)
  const profileTabs = profile?.workspaces.reduce((n, w) => n + tabCount(w), 0) ?? 0
  const allTabs = profiles.reduce((n, p) => n + p.workspaces.reduce((m, w) => m + tabCount(w), 0), 0)
  const allWorkspaces = profiles.reduce((n, p) => n + p.workspaces.length, 0)

  return (
    <div className="flex-1 min-w-0 flex items-center gap-4 px-3 text-xs text-muted-foreground whitespace-nowrap overflow-hidden select-none">
      <span className="text-foreground/80">Editing the address below</span>
      {workspace && (
        <span className="flex items-center gap-1.5" title="This workspace">
          <Layout size={13} />
          <span className="text-foreground/80">{workspace.name}</span>
          {plural(tabCount(workspace), 'tab')} · {plural(workspace.tabGroups.length, 'group')}
        </span>
      )}
      {profile && (
        <span className="flex items-center gap-1.5" title="This profile">
          <User size={13} />
          <span className="text-foreground/80">{profile.name}</span>
          {plural(profile.workspaces.length, 'workspace')} · {plural(profileTabs, 'tab')}
        </span>
      )}
      <span className="flex items-center gap-1.5" title="Every profile">
        <Globe size={13} />
        {plural(profiles.length, 'profile')} · {plural(allWorkspaces, 'workspace')} · {plural(allTabs, 'tab')}
      </span>
    </div>
  )
}
