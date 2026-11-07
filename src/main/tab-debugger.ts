// A page has one DevTools protocol client in Electron — its
// webContents.debugger — and more than one part of Newbro drives it: Dark
// pages (main/dark-pages.ts) and the chrome.debugger API extensions use
// (main/extensions/debugger.ts). Each holds it under its own name: it
// attaches with the first holder and detaches with the last, so neither
// knocks the other's session out from under it.

import type { WebContents } from 'electron'
import { log } from './log'

export type DebuggerHolder = 'dark-pages' | 'extension'

const holders = new WeakMap<WebContents, Set<DebuggerHolder>>()
const watched = new WeakSet<WebContents>()
type ReleaseListener = (wc: WebContents, holder: DebuggerHolder) => void
const releaseListeners = new Set<ReleaseListener>()

function holdersOf(wc: WebContents): Set<DebuggerHolder> {
  let set = holders.get(wc)
  if (!set) {
    set = new Set()
    holders.set(wc, set)
  }
  return set
}

/** Take a hold on the page's debugger, attaching it if nobody has. False
 *  when it can't be attached (the page is gone, or someone outside Newbro's
 *  holders has it). */
export function holdDebugger(wc: WebContents, holder: DebuggerHolder): boolean {
  if (wc.isDestroyed()) return false
  const set = holdersOf(wc)
  if (!wc.debugger.isAttached()) {
    // Whoever held a session that ended (the page's renderer went away)
    // holds nothing now.
    set.clear()
    try {
      wc.debugger.attach('1.3')
    } catch (err) {
      log.warn('tab-debugger: attach failed', { holder, err: String(err) })
      return false
    }
    if (!watched.has(wc)) {
      watched.add(wc)
      // The session ending on its own drops every hold on it.
      wc.debugger.on('detach', () => holders.get(wc)?.clear())
    }
  } else if (set.size === 0) {
    log.warn('tab-debugger: debugger attached outside the holders', { holder })
    return false
  }
  set.add(holder)
  return true
}

/** Let go of the page's debugger; the last holder out detaches it. */
export function releaseDebugger(wc: WebContents, holder: DebuggerHolder): void {
  const set = holders.get(wc)
  if (!set?.delete(holder)) return
  if (set.size === 0 && !wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      wc.debugger.detach()
    } catch (err) {
      log.warn('tab-debugger: detach failed', { holder, err: String(err) })
    }
    return
  }
  for (const listener of releaseListeners) {
    try { listener(wc, holder) } catch (err) { log.warn('tab-debugger: release listener threw', String(err)) }
  }
}

export function holdsDebugger(wc: WebContents, holder: DebuggerHolder): boolean {
  return !wc.isDestroyed() && wc.debugger.isAttached() && !!holders.get(wc)?.has(holder)
}

/** Called when a holder lets go of a session another still holds — that one
 *  may want to set the session back up its own way. */
export function onDebuggerReleased(listener: ReleaseListener): () => void {
  releaseListeners.add(listener)
  return () => { releaseListeners.delete(listener) }
}
