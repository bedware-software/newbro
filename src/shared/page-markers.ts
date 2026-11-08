// Names a web page can see: attributes and ids we put on its DOM, the event
// and window property the stand-in fullscreen uses in its main world, and
// the prefix of the lines our main-world scripts log to its console
// (src/preload/webview-stealth.ts). Any of them carrying the browser's name
// would let a site tell it's this browser, so they carry none — just a
// short opaque stem. They stay fixed between releases: main's Dark pages
// CSS (shared/dark-pages.ts) selects on the fullscreen attribute.
// Flags kept only in the preload's isolated world aren't here: pages can't
// see those.

const STEM = 'k9q'

/** CustomEvent the main-world fullscreen script raises for the preload. */
export const PSEUDO_FULLSCREEN_EVENT = `__${STEM}_fs__`
/** Window property marking the fullscreen script as installed. */
export const PSEUDO_FULLSCREEN_INSTALL_KEY = `__${STEM}Fs`
/** On <html> while a page is in the stand-in fullscreen. */
export const PSEUDO_FULLSCREEN_ROOT_ATTR = `data-${STEM}-fs`
/** On the element shown fullscreen. */
export const PSEUDO_FULLSCREEN_TARGET_ATTR = `data-${STEM}-fs-t`
/** id of the <style> the stand-in fullscreen adds. */
export const PSEUDO_FULLSCREEN_STYLE_ID = `${STEM}-fs-s`

/** The swipe-navigation arrow's element. */
export const SWIPE_OVERLAY_ATTR = `data-${STEM}-sw`
/** A password field we filled. */
export const PASSWORD_FILLED_ATTR = `data-${STEM}-pf`
/** The saved-password chooser and the save prompt's hosts. */
export const PASSWORD_UI_ATTR = `data-${STEM}-pu`

/** Prefix of what our main-world scripts log to the page's console. */
export const MAIN_WORLD_LOG_PREFIX = `[${STEM}]`
