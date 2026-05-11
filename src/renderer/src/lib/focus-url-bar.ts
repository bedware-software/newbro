// Focus the URL bar (the toolbar's #url-bar input) and select its current
// text so the user can immediately overwrite it.
//
// Two-step process is necessary because tabs are hosted as native
// `WebContentsView`s layered above the renderer DOM. When a tab page has OS
// keyboard focus (the common case while browsing), calling `.focus()` on a
// renderer-side input only sets DOM focus inside the parent webContents —
// the OS keeps routing keystrokes to the tab. We first ask main to pull OS
// focus back to the parent webContents, THEN focus the input. Without
// step 1, Cmd+L visually selects the URL bar but typed characters still go
// to the page.
export function focusAndSelectUrlBar(): void {
  // Best-effort — older preloads may not expose the method, in which case
  // we skip the OS-focus step (still degrades gracefully when the page
  // doesn't have OS focus, e.g. immediately after a fresh window open).
  window.electronAPI?.focusWindowRenderer?.()
  const urlBar = document.getElementById('url-bar') as HTMLInputElement | null
  if (!urlBar) return
  urlBar.focus()
  // The select() can race with focus() on some platforms / when the input
  // is being re-rendered; defer one tick and only select if focus actually
  // landed on the URL bar (the user might have shifted focus elsewhere).
  setTimeout(() => {
    if (document.activeElement !== urlBar) return
    try { urlBar.select() }
    catch (err) { console.warn('focusUrlBar: urlBar.select() threw:', err) }
  }, 0)
}
