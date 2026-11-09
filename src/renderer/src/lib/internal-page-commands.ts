// COMMAND's page keys on a page this window draws (Downloads, Bangs, the
// Keys), so they do there what they do on a web page
// (preload/webview-stealth.ts runCommand): j/k scroll a little, <C-d>/<C-u>
// half a page, gg/G to the ends, gi to the page's filter — the address bar
// (lib/address-filter.ts). The page marks what scrolls with data-vim-scroll,
// inside its data-vim-page root.

import { focusAddressFilter } from './address-filter'

/** A line of j/k, as a web page's (VIM_SCROLL_STEP in the preload). */
const SCROLL_STEP = 60

/** Runs a page command (vim-keys.ts isPageCommand) on the internal page
 *  shown; false when there's none, or nothing on it to run it on. */
export function runInternalPageCommand(command: string): boolean {
  const page = document.querySelector<HTMLElement>('[data-vim-page]')
  if (!page) return false
  if (command === 'focus-input') {
    // A web page's gi picks one of its fields; these pages have one to type
    // in — their filter, the address bar — so it goes straight there:
    // INSERT. A form open over the page (the bang form, a data-vim-page of
    // its own inside it) has its own fields first.
    const pages = document.querySelectorAll<HTMLElement>('[data-vim-page]')
    const top = pages[pages.length - 1] ?? page
    const fieldIn = (root: HTMLElement): HTMLInputElement | null =>
      root.querySelector<HTMLInputElement>('[data-vim-search]') ??
      root.querySelector<HTMLInputElement>('input[type="text"], input[type="search"], input:not([type])')
    if (top !== page) {
      const field = fieldIn(top)
      if (field) {
        field.focus()
        field.select()
        return true
      }
    }
    if (focusAddressFilter()) return true
    const field = fieldIn(page)
    if (!field) return false
    field.focus()
    field.select()
    return true
  }
  const scroller = page.querySelector<HTMLElement>('[data-vim-scroll]')
  if (!scroller) return false
  const by = (top: number): void => scroller.scrollBy({ top, behavior: 'smooth' })
  switch (command) {
    case 'scroll-down': by(SCROLL_STEP); return true
    case 'scroll-up': by(-SCROLL_STEP); return true
    case 'half-page-down': by(scroller.clientHeight / 2); return true
    case 'half-page-up': by(-scroller.clientHeight / 2); return true
    case 'page-top': scroller.scrollTo({ top: 0, behavior: 'smooth' }); return true
    case 'page-bottom': scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); return true
  }
  return false
}
