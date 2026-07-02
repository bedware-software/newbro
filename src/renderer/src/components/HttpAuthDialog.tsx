import { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { DetachedWindow } from './DetachedWindow'
import type { HttpAuthRequest } from '../App'

interface Props {
  request: HttpAuthRequest
  /** Called after we've responded (submit or cancel) so the parent drops this
   *  request from its queue. */
  onDone: () => void
}

/** Native-style HTTP auth prompt (Basic / Digest / NTLM / Negotiate). Shown
 *  when a site or proxy challenges with 401/407; the answer is fed back to
 *  Chromium's login callback in the main process. Closing without submitting
 *  cancels the request (the page stays at 401). */
export function HttpAuthDialog({ request, onDone }: Props) {
  const [username, setUsername] = useState(request.savedUsername ?? '')
  const [password, setPassword] = useState('')
  // Offer to remember only for real server sign-ins; default on so corp mail
  // stops asking after the first success. A rejected saved credential keeps it
  // ticked so the fix is remembered too.
  const canSave = request.canSave !== false
  const [remember, setRemember] = useState(canSave)
  const userRef = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)
  const respondedRef = useRef(false)

  useEffect(() => {
    // If we pre-filled the username (saved sign-in was rejected), jump straight
    // to the password so the user just corrects the part that's wrong.
    const t = setTimeout(() => (request.savedUsername ? passRef.current : userRef.current)?.focus(), 60)
    return () => clearTimeout(t)
  }, [request.savedUsername])

  const respond = (payload: { id: string; username?: string; password?: string; remember?: boolean; cancel?: boolean }): void => {
    if (respondedRef.current) return
    respondedRef.current = true
    window.electronAPI.httpAuthRespond?.(payload)
    onDone()
  }
  const submit = (): void => respond({ id: request.id, username, password, remember: canSave && remember })
  const cancel = (): void => respond({ id: request.id, cancel: true })

  const target = request.isProxy ? `proxy ${request.host}` : request.host
  // NTLM / Negotiate typically want a domain-qualified name.
  const wantsDomain = request.scheme === 'ntlm' || request.scheme === 'negotiate'

  return (
    <DetachedWindow
      open
      title="Sign in - Newbro"
      width={440}
      height={288 + (wantsDomain ? 24 : 0) + (canSave ? 40 : 0) + (request.hadSavedCredential ? 32 : 0)}
      resizable={false}
      closeOnEscape
      onClose={cancel}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); submit() }}
        className="h-full bg-popover text-popover-foreground border border-border rounded-lg overflow-hidden flex flex-col"
      >
        <div data-detached-drag-handle className="flex items-center gap-3 px-5 pt-5 pb-3 shrink-0">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-primary shrink-0">
            <Lock size={17} />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Sign in to access this site</h3>
            <p className="text-[11px] text-muted-foreground truncate" title={target}>
              Authorization required by {target}
            </p>
          </div>
        </div>

        <div className="flex-1 px-5 flex flex-col gap-3 justify-center">
          {request.hadSavedCredential ? (
            <p className="text-[11px] text-amber-500">
              Your saved sign-in for this site didn&apos;t work — update it below.
            </p>
          ) : null}
          {request.realm ? (
            <p className="text-[11px] text-muted-foreground">Realm: <span className="text-foreground">{request.realm}</span></p>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">User name</span>
            <input
              ref={userRef}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="h-8 px-2 rounded-md bg-secondary border border-border text-sm text-foreground outline-none focus:border-primary/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">Password</span>
            <input
              ref={passRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-8 px-2 rounded-md bg-secondary border border-border text-sm text-foreground outline-none focus:border-primary/60"
            />
          </label>
          {wantsDomain ? (
            <p className="text-[10px] text-muted-foreground/80">Use <span className="text-foreground">DOMAIN\username</span> (or username@domain) if your organization requires it.</p>
          ) : null}
          {canSave ? (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              <span className="text-[11px] text-muted-foreground">
                Remember on this device — sign in automatically next time
              </span>
            </label>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border bg-toolbar shrink-0">
          <button
            type="button"
            onClick={cancel}
            className="h-8 px-3 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="h-8 px-3 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            Sign in
          </button>
        </div>
      </form>
    </DetachedWindow>
  )
}
