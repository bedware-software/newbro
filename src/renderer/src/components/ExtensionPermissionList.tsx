import { describeExtensionPermissions } from '../lib/extension-permissions'

interface Props {
  permissions: string[]
  hostPermissions: string[]
  optionalPermissions?: string[]
  contentScriptMatches?: string[]
}

/** What an extension can do (Chrome-style warnings), then every permission
 *  it declares, grouped. Shared by Settings → Extensions and the install
 *  prompt. */
export function ExtensionPermissionList({
  permissions,
  hostPermissions,
  optionalPermissions = [],
  contentScriptMatches = [],
}: Props) {
  const warnings = describeExtensionPermissions({ permissions, hostPermissions, contentScriptMatches })
  return (
    <div className="flex flex-col gap-3">
      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 text-xs text-foreground leading-relaxed">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              {w}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Needs no special permissions.</p>
      )}
      <PermissionGroup title="Site access" items={hostPermissions} />
      <PermissionGroup title="Runs scripts on" items={contentScriptMatches} />
      <PermissionGroup title="API permissions" items={permissions} />
      <PermissionGroup title="Optional, requested later" items={optionalPermissions} />
    </div>
  )
}

function PermissionGroup({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title} · {items.length}
      </div>
      <div className="flex flex-wrap gap-1">
        {items.map((p) => (
          <span
            key={p}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground select-text break-all"
          >
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}
