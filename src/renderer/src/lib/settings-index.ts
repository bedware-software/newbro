// What Settings' filter (/) searches: every setting by its section, its name
// and the words it goes by, and the control it lands on (its data-vim-item
// id, lib/vim-form.ts). A list of its own rather than a look at the page:
// only the section shown is rendered, and the filter finds settings in all
// of them. A setting added to SettingsDialog belongs here too.

import { fuzzyFilter } from './fuzzy'
import { PERMISSION_KINDS, PERMISSION_LABEL } from './permissions'

export type SettingsSection =
  | 'general' | 'appearance' | 'darkPages' | 'passwords' | 'network' | 'enterprise'
  | 'shortcuts' | 'extensions' | 'permissions' | 'sync' | 'about'

/** The sections in the order Settings lists them — About last, at the
 *  bottom. J / K go through them in this order. */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'darkPages', label: 'Dark pages' },
  { id: 'passwords', label: 'Passwords' },
  { id: 'network', label: 'Network' },
  { id: 'enterprise', label: 'Enterprise' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'permissions', label: 'Site permissions' },
  { id: 'sync', label: 'Cloud Sync' },
  { id: 'about', label: 'About' },
]

export function settingsSectionLabel(section: SettingsSection): string {
  return SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? section
}

export interface SettingsIndexEntry {
  section: SettingsSection
  /** The control's data-vim-item id. */
  item: string
  title: string
  /** Other words it goes by. */
  keywords?: string
  /** Where the cursor goes when the control isn't there (shown only in
   *  some state, like a custom proxy's fields). */
  fallback?: string
}

/** What decides which settings exist right now. */
export interface SettingsIndexContext {
  /** The other-browser picker (macOS and Windows). */
  otherBrowser: boolean
}

const STATIC: SettingsIndexEntry[] = [
  // General
  { section: 'general', item: 'general:default-url', title: 'Default New Tab URL', keywords: 'new tab page home start blank' },
  { section: 'general', item: 'general:new-tab-focus', title: 'Focus on New Tab', keywords: 'site url bar address keyboard' },
  { section: 'general', item: 'general:url-editor-click', title: 'Address editor: click on the address', keywords: 'url bar edit insert command mode' },
  { section: 'general', item: 'general:url-editor-new-tab', title: 'Address editor: new tab', keywords: 'url bar edit insert command mode nt nn' },
  { section: 'general', item: 'general:url-editor-edit', title: 'Address editor: edit the address (e)', keywords: 'url bar edit insert command mode e' },
  { section: 'general', item: 'general:search-engine', title: 'Default Search Engine', keywords: 'google yandex duckduckgo bing unduck' },
  { section: 'general', item: 'general:custom-engine', title: 'Custom search engine', keywords: 'url template %s', fallback: 'general:search-engine' },
  { section: 'general', item: 'general:suggestions', title: 'Show search suggestions', keywords: 'address bar autocomplete' },
  { section: 'general', item: 'general:bangs', title: 'Bangs', keywords: '!w shortcuts search' },
  { section: 'general', item: 'general:manage-bangs', title: 'Manage bangs', keywords: 'bangs page' },
  { section: 'general', item: 'general:default-browser', title: 'Default browser', keywords: 'make default open links' },
  { section: 'general', item: 'general:other-browser', title: 'Open links in another browser', keywords: 'pass on safari chrome' },
  { section: 'general', item: 'general:test-notification', title: 'Notifications', keywords: 'test notification toast' },
  { section: 'general', item: 'general:wipe', title: 'Wipe all data', keywords: 'danger zone reset delete everything' },
  // Appearance
  { section: 'appearance', item: 'appearance:theme', title: 'Theme', keywords: 'dark light system colours' },
  { section: 'appearance', item: 'appearance:light-variant', title: 'Light variant', keywords: 'theme bright soft', fallback: 'appearance:theme' },
  { section: 'appearance', item: 'appearance:dark-variant', title: 'Dark variant', keywords: 'theme deep soft', fallback: 'appearance:theme' },
  { section: 'appearance', item: 'appearance:density', title: 'Density', keywords: 'compact normal sidebar rows' },
  { section: 'appearance', item: 'appearance:vim-indicator', title: 'Vim mode indicator', keywords: 'cmd ins key cap badge colour', fallback: 'appearance:theme' },
  { section: 'appearance', item: 'appearance:vim-edge', title: 'Vim mode edge', keywords: 'address bar light comet', fallback: 'appearance:theme' },
  { section: 'appearance', item: 'appearance:vim-edge-everywhere', title: 'Vim mode edge on every field', keywords: 'search find palette', fallback: 'appearance:theme' },
  // Dark pages
  { section: 'darkPages', item: 'dark:mode', title: 'Dark pages', keywords: 'off on theme night mode' },
  { section: 'darkPages', item: 'dark:style', title: 'Dark pages style', keywords: 'smart native own themes' },
  { section: 'darkPages', item: 'dark:brightness', title: 'Brightness', keywords: 'dark pages comfort' },
  { section: 'darkPages', item: 'dark:contrast', title: 'Contrast', keywords: 'dark pages comfort' },
  { section: 'darkPages', item: 'dark:warmth', title: 'Warmth', keywords: 'dark pages comfort sepia night' },
  { section: 'darkPages', item: 'dark:site-input', title: 'Dark pages sites', keywords: 'always never dark rule site' },
  // Passwords
  { section: 'passwords', item: 'pw:enabled', title: 'Use Vimperium password manager', keywords: 'passwords fill save' },
  { section: 'passwords', item: 'pw:offer', title: 'Offer to save passwords', keywords: 'prompt sign-in' },
  { section: 'passwords', item: 'pw:autofill', title: 'Autofill behavior', keywords: 'fill automatically focus never' },
  { section: 'passwords', item: 'pw:profile', title: 'Saved passwords', keywords: 'profile vault' },
  { section: 'passwords', item: 'pw:add', title: 'Add password', keywords: 'new entry' },
  { section: 'passwords', item: 'pw:import-csv', title: 'Import passwords from CSV', keywords: 'import file' },
  { section: 'passwords', item: 'pw:edge-import', title: 'Import passwords from Microsoft Edge', keywords: 'edge import', fallback: 'pw:import-csv' },
  { section: 'passwords', item: 'pw:search', title: 'Search saved passwords', keywords: 'websites usernames', fallback: 'pw:profile' },
  // Network
  { section: 'network', item: 'network:proxy', title: 'Proxy', keywords: 'system direct custom socks http' },
  { section: 'network', item: 'network:proxy-rules', title: 'Proxy server', keywords: 'custom proxy rules', fallback: 'network:proxy' },
  { section: 'network', item: 'network:proxy-bypass', title: 'Proxy bypass list', keywords: 'custom proxy loopback', fallback: 'network:proxy' },
  { section: 'network', item: 'network:doh', title: 'DNS-over-HTTPS', keywords: 'doh dns secure automatic' },
  // Enterprise
  { section: 'enterprise', item: 'enterprise:sso', title: 'Integrated Windows Authentication (SSO)', keywords: 'ntlm kerberos allowlist hosts' },
  { section: 'enterprise', item: 'enterprise:clear-creds', title: 'Saved sign-ins', keywords: 'http auth credentials remember', fallback: 'enterprise:sso' },
  // Keyboard Shortcuts — Vim's: it's the only mode, so there's no switch to
  // land on and no list of regular shortcuts; the keymap takes Vim Mode's
  // words.
  { section: 'shortcuts', item: 'shortcuts:hide-sidebar-insert', title: 'Hide the Sidebar in INSERT', keywords: 'vim sidebar insert' },
  { section: 'shortcuts', item: 'shortcuts:vim-keymap', title: 'Vim keymap', keywords: 'vim mode keys bindings shortcuts command insert vimium esc escape ctrl popup config' },
  // Extensions
  { section: 'extensions', item: 'ext:install-input', title: 'Install an extension', keywords: 'chrome web store crx id' },
  { section: 'extensions', item: 'ext:store-chrome', title: 'Chrome Web Store', keywords: 'extensions store' },
  { section: 'extensions', item: 'ext:store-edge', title: 'Edge Add-ons', keywords: 'extensions store' },
  // Site permissions
  { section: 'permissions', item: 'perm:add-origin', title: 'Add a site permission', keywords: 'exception allow block site' },
  // Cloud Sync
  { section: 'sync', item: 'sync:enabled', title: 'Enable cloud sync', keywords: 'sync onedrive dropbox icloud google drive' },
  { section: 'sync', item: 'sync:choose-folder', title: 'Sync folder', keywords: 'choose folder sync' },
  { section: 'sync', item: 'sync:now', title: 'Sync now', keywords: 'sync manual' },
  { section: 'sync', item: 'sync:restart', title: 'Restart Cloud Sync setup', keywords: 'sync setup reset' },
  // About
  { section: 'about', item: 'about:update', title: 'Check for updates', keywords: 'version update install release' },
  { section: 'about', item: 'about:path:User data', title: 'User data folder', keywords: 'paths storage copy' },
  { section: 'about', item: 'about:path:Logs', title: 'Logs folder', keywords: 'paths log copy' },
  { section: 'about', item: 'about:author:dmitry', title: 'Made by', keywords: 'credits authors creators dmitry surin claude anthropic' },
  // The list's first row (lib/credits.ts).
  { section: 'about', item: 'about:oss:electron', title: 'Open source', keywords: 'credits libraries licenses oss third party acknowledgements thanks vim vimium' },
]

/** The sync categories Settings → Cloud Sync lists, by id. Mirrored from
 *  SettingsDialog's SYNC_CATEGORY_LABELS (titles only). */
const SYNC_CATEGORIES: Array<{ id: string; title: string }> = [
  { id: 'state', title: 'Sync tabs & workspaces' },
  { id: 'bookshelf', title: 'Sync the Bookshelf' },
  { id: 'settings', title: 'Sync settings & keybindings' },
  { id: 'history', title: 'Sync history' },
  { id: 'permissions', title: 'Sync site permissions' },
  { id: 'extensions', title: 'Sync extensions' },
  { id: 'darkPages', title: 'Sync dark pages' },
]

/** Every setting there is now. */
export function settingsIndex(ctx: SettingsIndexContext): SettingsIndexEntry[] {
  const out = STATIC.filter((entry) => entry.item !== 'general:other-browser' || ctx.otherBrowser)
  for (const { id, title } of SYNC_CATEGORIES) {
    out.push({ section: 'sync', item: `sync-cat:${id}`, title, keywords: 'what to sync', fallback: 'sync:enabled' })
  }
  for (const kind of PERMISSION_KINDS) {
    out.push({ section: 'permissions', item: `perm-default:${kind}`, title: `${PERMISSION_LABEL[kind]} permission`, keywords: 'default behavior ask allow block' })
  }
  return out
}

/** The settings matching `query`, best first. */
export function filterSettingsIndex(query: string, entries: readonly SettingsIndexEntry[]): SettingsIndexEntry[] {
  if (!query.trim()) return []
  return fuzzyFilter(query.trim(), entries, (entry) => [
    { value: entry.title, weight: 1 },
    { value: entry.keywords, weight: 0.6 },
    { value: settingsSectionLabel(entry.section), weight: 0.4 },
  ])
}
