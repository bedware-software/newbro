// What the address bar shows while the address editor has the address
// (UrlEditor.tsx): how much is open — here, in this profile, everywhere;
// and the same as a card in Settings → About.
// Centred in the bar; each scope a group with its name and numbers in bold,
// the groups set apart by dividers.

import type { ReactNode } from 'react'
import { Globe, Layout, User } from 'lucide-react'
import { useAppStore } from '../store/app-store'
import type { Workspace } from '../store/types'

function tabCount(w: Workspace): number {
  return (w.tabs?.length ?? 0) + w.tabGroups.reduce((n, g) => n + g.tabs.length, 0)
}

/** A number, standing out from the word after it. */
function Count({ n, one, many = `${one}s` }: { n: number; one: string; many?: string }) {
  return (
    <span>
      <span className="font-semibold text-foreground tabular-nums">{n}</span> {n === 1 ? one : many}
    </span>
  )
}

function Scope({ icon, name, title, children }: { icon: ReactNode; name: string; title: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0" title={title}>
      {icon}
      <span className="font-semibold text-foreground truncate max-w-40">{name}</span>
      <span className="flex items-center gap-1.5 shrink-0">{children}</span>
    </span>
  )
}

const Dot = () => <span className="text-muted-foreground/70">·</span>
const Divider = () => <span className="w-px h-4 shrink-0 bg-muted-foreground/40" />

/** How much is open, here, in this profile and everywhere. */
function useStats() {
  const profiles = useAppStore((s) => s.profiles)
  const activeProfileId = useAppStore((s) => s.activeProfileId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const profile = profiles.find((p) => p.id === activeProfileId)
  const workspace = profile?.workspaces.find((w) => w.id === activeWorkspaceId)
  const profileTabs = profile?.workspaces.reduce((n, w) => n + tabCount(w), 0) ?? 0
  const allTabs = profiles.reduce((n, p) => n + p.workspaces.reduce((m, w) => m + tabCount(w), 0), 0)
  const allWorkspaces = profiles.reduce((n, p) => n + p.workspaces.length, 0)
  const allGroups = profiles.reduce((n, p) => n + p.workspaces.reduce((m, w) => m + w.tabGroups.length, 0), 0)
  return { profiles, profile, workspace, profileTabs, allTabs, allWorkspaces, allGroups }
}

/** The same numbers as rows of a card: Settings → About. */
export function WorkspaceStatsCard() {
  const { profiles, profile, workspace, profileTabs, allTabs, allWorkspaces, allGroups } = useStats()
  const row = (icon: ReactNode, label: string, name: string | null, counts: ReactNode) => (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="shrink-0">{label}</span>
        {name && <span className="truncate font-normal text-muted-foreground">{name}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground">{counts}</div>
    </div>
  )
  return (
    <div className="flex flex-col divide-y divide-border border border-input rounded-md bg-card overflow-hidden">
      {workspace && row(<Layout size={14} />, 'This workspace', workspace.name, (
        <><Count n={tabCount(workspace)} one="tab" /><Dot /><Count n={workspace.tabGroups.length} one="group" /></>
      ))}
      {profile && row(<User size={14} />, 'This profile', profile.name, (
        <><Count n={profile.workspaces.length} one="workspace" /><Dot /><Count n={profileTabs} one="tab" /></>
      ))}
      {row(<Globe size={14} />, 'Everywhere', null, (
        <>
          <Count n={profiles.length} one="profile" /><Dot />
          <Count n={allWorkspaces} one="workspace" /><Dot />
          <Count n={allGroups} one="group" /><Dot />
          <Count n={allTabs} one="tab" />
        </>
      ))}
    </div>
  )
}

export function WorkspaceStats() {
  const { profiles, profile, workspace, profileTabs, allTabs, allWorkspaces } = useStats()

  return (
    <div className="flex-1 min-w-0 h-full flex items-center justify-center-safe gap-3.5 px-3 text-[13px] text-muted-foreground whitespace-nowrap overflow-hidden select-none">
      {workspace && (
        <>
          <Scope icon={<Layout size={14} />} name={workspace.name} title="This workspace">
            <Count n={tabCount(workspace)} one="tab" />
            <Dot />
            <Count n={workspace.tabGroups.length} one="group" />
          </Scope>
          <Divider />
        </>
      )}
      {profile && (
        <>
          <Scope icon={<User size={14} />} name={profile.name} title="This profile">
            <Count n={profile.workspaces.length} one="workspace" />
            <Dot />
            <Count n={profileTabs} one="tab" />
          </Scope>
          <Divider />
        </>
      )}
      <Scope icon={<Globe size={14} />} name="All" title="Every profile">
        <Count n={profiles.length} one="profile" />
        <Dot />
        <Count n={allWorkspaces} one="workspace" />
        <Dot />
        <Count n={allTabs} one="tab" />
      </Scope>
    </div>
  )
}
