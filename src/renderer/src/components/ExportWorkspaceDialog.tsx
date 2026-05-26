import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, Upload, Layers } from 'lucide-react'
import type { Workspace } from '../store/types'
import { DetachedWindow } from './DetachedWindow'

interface Props {
  open: boolean
  workspaces: Workspace[]
  /** Active profile name. Shown in the title + subtitle so the user knows
   *  which profile's workspaces they're exporting — important once you
   *  have more than one profile and several similarly-named workspaces. */
  profileName?: string
  onConfirm: (selected: Workspace[]) => void
  onCancel: () => void
}

export function ExportWorkspaceDialog({ open, workspaces, profileName, onConfirm, onCancel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const confirmRef = useRef<HTMLButtonElement>(null)

  // Reset selection state whenever the dialog opens with a fresh workspace
  // list. Defaults to "all workspaces selected" so the common case (export
  // everything) is a single click.
  useEffect(() => {
    if (!open) return
    setSelected(new Set(workspaces.map((w) => w.id)))
    setExpanded(new Set())
    setTimeout(() => confirmRef.current?.focus(), 50)
  }, [open, workspaces])

  const allSelected = workspaces.length > 0 && selected.size === workspaces.length
  const noneSelected = selected.size === 0

  const totals = useMemo(() => {
    let tabs = 0
    let groups = 0
    for (const w of workspaces) {
      if (!selected.has(w.id)) continue
      tabs += w.tabs.length
      for (const g of w.tabGroups) tabs += g.tabs.length
      groups += w.tabGroups.length
    }
    return { tabs, groups }
  }, [selected, workspaces])

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = (): void => {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(workspaces.map((w) => w.id)))
  }

  const handleExport = (): void => {
    const picked = workspaces.filter((w) => selected.has(w.id))
    if (picked.length === 0) return
    onConfirm(picked)
  }

  if (!open) return null

  return (
    <DetachedWindow
      open={open}
      title="Export Workspaces - Newbro"
      width={560}
      height={560}
      onClose={onCancel}
    >
      <div className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col">
        <div
          data-detached-drag-handle
          className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0"
        >
          <Upload size={16} className="text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-foreground">Export Workspaces</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {workspaces.length === 0
                ? `No workspaces to export${profileName ? ` (${profileName})` : ''}.`
                : `${workspaces.length} workspace${workspaces.length === 1 ? '' : 's'} in this profile${profileName ? ` (${profileName})` : ''}`}
            </div>
          </div>
          {workspaces.length > 0 && (
            <button
              data-detached-no-drag
              onClick={toggleAll}
              className="h-7 px-2.5 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground shrink-0"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {workspaces.length === 0 && (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              This profile has no workspaces to export.
            </div>
          )}
          {workspaces.map((w) => {
            const isSelected = selected.has(w.id)
            const isExpanded = expanded.has(w.id)
            const tabCount = w.tabs.length + w.tabGroups.reduce((n, g) => n + g.tabs.length, 0)
            const order = w.sidebarOrder && w.sidebarOrder.length > 0
              ? w.sidebarOrder
              : [...w.tabs.map((t) => t.id), ...w.tabGroups.map((g) => g.id)]
            return (
              <div key={w.id} className="px-2">
                <div
                  className={`flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer ${
                    isSelected ? 'bg-accent/40' : 'hover:bg-accent/30'
                  }`}
                  onClick={() => toggleExpand(w.id)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => {
                      e.stopPropagation()
                      toggleSelect(w.id)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="h-3.5 w-3.5 shrink-0 accent-primary cursor-pointer"
                  />
                  <ChevronRight
                    size={14}
                    className={`text-muted-foreground shrink-0 transition-transform ${
                      isExpanded ? 'rotate-90' : ''
                    }`}
                  />
                  <Folder size={14} className="text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-foreground truncate">{w.name}</div>
                  </div>
                  <div className="text-[10px] text-muted-foreground shrink-0">
                    {w.tabGroups.length} group{w.tabGroups.length === 1 ? '' : 's'} · {tabCount} tab{tabCount === 1 ? '' : 's'}
                  </div>
                </div>
                {isExpanded && (() => {
                  const tabMap = new Map(w.tabs.map((t) => [t.id, t]))
                  const groupMap = new Map(w.tabGroups.map((g) => [g.id, g]))
                  return (
                    <div className="ml-8 mb-1 pl-2 border-l border-border/60">
                      {order.map((id) => {
                        const tab = tabMap.get(id)
                        if (tab) {
                          return (
                            <div
                              key={tab.id}
                              className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground"
                              title={tab.url}
                            >
                              <div className="w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                              <span className="truncate">{tab.title}</span>
                            </div>
                          )
                        }
                        const group = groupMap.get(id)
                        if (!group) return null
                        return (
                          <div key={group.id} className="py-1">
                            <div className="flex items-center gap-2 px-2 text-[11px] text-foreground">
                              <Layers size={11} className="shrink-0" style={{ color: group.color }} />
                              <span className="truncate">{group.name}</span>
                              <span className="text-muted-foreground ml-auto shrink-0">
                                {group.tabs.length} tab{group.tabs.length === 1 ? '' : 's'}
                              </span>
                            </div>
                            <div className="ml-5 mt-0.5">
                              {group.tabs.map((t) => (
                                <div
                                  key={t.id}
                                  className="flex items-center gap-2 px-2 py-0.5 text-[11px] text-muted-foreground"
                                  title={t.url}
                                >
                                  <div className="w-1 h-1 rounded-full bg-muted-foreground/60 shrink-0" />
                                  <span className="truncate">{t.title}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>

        <div
          data-detached-drag-handle
          className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border shrink-0"
        >
          <div className="text-[10px] text-muted-foreground">
            {noneSelected
              ? 'Select workspaces to export'
              : `${selected.size} selected · ${totals.groups} groups · ${totals.tabs} tabs`}
          </div>
          <div className="flex gap-2" data-detached-no-drag>
            <button
              onClick={onCancel}
              className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              ref={confirmRef}
              onClick={handleExport}
              disabled={noneSelected}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onCancel()
              }}
              className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Export {noneSelected ? '' : `(${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </DetachedWindow>
  )
}
