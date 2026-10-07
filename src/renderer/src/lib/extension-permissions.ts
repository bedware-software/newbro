// What an extension's permissions let it do, worded like Chrome's install
// prompt ("It can: Read and change all your data on all websites", …).
// Permissions with no user-visible risk (storage, alarms, …) get no line,
// as in Chrome; the raw lists are shown alongside for the full picture.

export interface ExtensionPermissionSet {
  permissions: string[]
  hostPermissions: string[]
  contentScriptMatches?: string[]
}

const API_WARNINGS: Record<string, string> = {
  bookmarks: 'Read and change your bookmarks',
  history: 'Read and change your browsing history',
  tabs: 'Read your browsing history',
  webNavigation: 'Read your browsing history',
  declarativeNetRequestFeedback: 'Read your browsing history',
  topSites: 'Read a list of your most frequently visited websites',
  sessions: 'Read your recently closed tabs and browsing sessions',
  downloads: 'Manage your downloads',
  'downloads.open': 'Open downloaded files',
  management: 'Manage your apps, extensions, and themes',
  clipboardRead: 'Read data you copy and paste',
  clipboardWrite: 'Modify data you copy and paste',
  notifications: 'Display notifications',
  geolocation: 'Detect your physical location',
  privacy: 'Change your privacy-related settings',
  proxy: 'Route your traffic through a proxy',
  debugger: 'Access the page debugger backend',
  nativeMessaging: 'Communicate with cooperating native applications',
  desktopCapture: 'Capture content of your screen',
  tabCapture: 'Capture the content of your tabs',
  pageCapture: 'Read the full content of pages you visit',
  audioCapture: 'Use your microphone',
  videoCapture: 'Use your camera',
  contentSettings:
    "Change your settings that control websites' access to features such as cookies, JavaScript, location, microphone and camera",
  declarativeNetRequest: 'Block content on any page',
  'identity.email': 'Know your email address',
  tabGroups: 'View and manage your tab groups',
  favicon: 'Read the icons of the websites you visit',
  readingList: 'Read and change entries in the reading list',
  'system.storage': 'Identify and eject storage devices',
  userScripts: 'Run user scripts on websites',
}

const BROWSING_HISTORY = 'Read your browsing history'

/** The host of a match pattern, '*' for every host, or null for patterns
 *  that don't name web hosts (file:, chrome-extension:, malformed). */
function patternHost(pattern: string): string | null {
  if (pattern === '<all_urls>') return '*'
  const m = /^(\*|https?|wss?|ftp):\/\/([^/]*)/.exec(pattern)
  return m ? m[2] || null : null
}

function hostWarning(patterns: string[]): string | null {
  const hosts = new Set<string>()
  for (const p of patterns) {
    const host = patternHost(p)
    if (host === '*') return 'Read and change all your data on all websites'
    if (host) hosts.add(host.startsWith('*.') ? `all ${host.slice(2)} sites` : host)
  }
  const list = [...hosts].sort()
  if (list.length === 0) return null
  if (list.length === 1) return `Read and change your data on ${list[0]}`
  if (list.length === 2) return `Read and change your data on ${list[0]} and ${list[1]}`
  if (list.length === 3) return `Read and change your data on ${list[0]}, ${list[1]}, and ${list[2]}`
  return `Read and change your data on ${list.length} websites`
}

/** Chrome-style warnings for what the extension can do, most sweeping
 *  first. Empty when it needs nothing worth warning about. */
export function describeExtensionPermissions(set: ExtensionPermissionSet): string[] {
  const out: string[] = []
  const hosts = hostWarning([...set.hostPermissions, ...(set.contentScriptMatches ?? [])])
  if (hosts) out.push(hosts)
  for (const p of set.permissions) {
    const w = API_WARNINGS[p]
    if (w && !out.includes(w)) out.push(w)
  }
  // Access to every site, or to the history itself, already covers
  // reading the browsing history.
  const coversHistory =
    hosts === 'Read and change all your data on all websites' || out.includes(API_WARNINGS.history)
  return coversHistory ? out.filter((w) => w !== BROWSING_HISTORY) : out
}
