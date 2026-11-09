// Focus the address bar (the toolbar's #url-bar input) and select its text,
// so what's typed replaces it: e, Cmd/Ctrl+L, a new tab. On a page this
// window draws, the bar is the page's filter (lib/address-filter.ts), and
// that's what takes the keys.
//
// Two steps, as tabs are native WebContentsViews above the renderer: while
// a page has the OS keyboard, focusing an input here only moves DOM focus
// inside the window's own webContents and the keys keep going to the page.
// Main brings the keyboard to the window first, then the input takes it.
export function focusAndSelectUrlBar(): void {
  window.electronAPI?.focusWindowRenderer?.()
  // The input is looked up a tick later, not now: the bar is two different
  // inputs — the address, or a page's filter — and a tab switch that puts
  // a page of this window's in place of a web page (or back) swaps one for
  // the other only in the render that follows the switch's. Found now, the
  // input taking the keys would be the one about to go, and the keys with it.
  setTimeout(() => {
    const urlBar = document.getElementById('url-bar') as HTMLInputElement | null
    if (!urlBar) return
    urlBar.focus()
    // select() can race focus() while the input re-renders: a tick later,
    // and only if the focus stayed.
    setTimeout(() => {
      if (document.activeElement !== urlBar) return
      try { urlBar.select() } catch { /* nothing to select */ }
    }, 0)
  }, 0)
}
