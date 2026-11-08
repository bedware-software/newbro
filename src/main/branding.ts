// Side-effect module — MUST be imported before any other internal module
// that constructs an `electron-store` (or otherwise reads
// `app.getPath('userData')`).
//
// `electron-store` resolves its target file at construction time using
// `app.getPath('userData')`, which is derived from `app.getName()`. If we
// don't rename the app first, every store gets pinned to
// `~/Library/Application Support/Vimperium/` no matter what we do later in
// the entry point. Putting the rename in its own module imported FIRST in
// `src/main/index.ts` is what guarantees the dev / stable split actually
// affects on-disk paths.
//
// Why a different name in dev: a packaged production install and a dev
// run otherwise share the same userData/cache/cookies — installing or
// uninstalling extensions in one shows up in the other, profile state
// gets crossed, and tests trash the user's real data. Renaming to
// "Vimperium Dev" routes everything to a sibling directory.

import { app } from 'electron'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { is } from '@electron-toolkit/utils'
import { migrateFromNewbro } from './rename-migration'

// Test mode for the Newbro → Vimperium migration, dev builds only: with
// VIMPERIUM_TEST_APPDATA=<dir> in the environment, appData is <dir>, the app
// runs as "Vimperium Test" and migrates from <dir>/Newbro Dev. The name keeps
// Electron's own keychain item apart too ("Vimperium Test Safe Storage"), and
// the migration leaves the keychain alone, so a test run (the orchestrator
// trying the migration on a copied profile) never touches the user's real
// folders or keychain items. Packaged builds ignore the variable.
const TEST_APPDATA = is.dev ? process.env.VIMPERIUM_TEST_APPDATA?.trim() || undefined : undefined
export const MIGRATION_TEST_MODE = TEST_APPDATA !== undefined
if (TEST_APPDATA !== undefined) {
  const dir = resolve(TEST_APPDATA)
  mkdirSync(dir, { recursive: true }) // setPath throws for a folder that doesn't exist
  app.setPath('appData', dir)
}

export const APP_NAME = MIGRATION_TEST_MODE ? 'Vimperium Test' : is.dev ? 'Vimperium Dev' : 'Vimperium'

/** The app's name before it became Vimperium, which its userData folder, its
 *  macOS keychain item and its Windows registration still carry. Kept so the
 *  first Vimperium launch can bring all of that over (rename-migration.ts,
 *  default-browser.ts). */
export const LEGACY_APP_NAME = is.dev ? 'Newbro Dev' : 'Newbro'

// Moves Newbro's userData folder (and its keychain key) over to the new name.
// It has to come before anything resolves userData — app.setName below, the
// first electron-store, ./log — so it runs here, synchronously.
migrateFromNewbro({ appName: APP_NAME, legacyName: LEGACY_APP_NAME, testMode: MIGRATION_TEST_MODE })

// Must be set before app.whenReady() and before any electron-store
// instance is constructed. Both are guaranteed by importing this module
// as the first internal import in src/main/index.ts.
app.setName(APP_NAME)

// Windows taskbar groups windows by AppUserModelID. Without an explicit one
// the process starts with none — its windows group by whatever launched it
// (the NSIS shortcut's ID, or the bare exe path for prod-iter / updater
// relaunches) — and Electron then lazily assigns `electron.app.<name>` the
// first time something needs it (a site's toast notification). Windows
// opened after that land in a separate taskbar group from the earlier ones.
// Pin it up front, before any window exists, to the ID electron-builder
// stamps on the installer's shortcuts (package.json build.appId); dev gets
// its own so `npm run dev` windows don't merge with the installed app.
if (process.platform === 'win32') {
  app.setAppUserModelId(is.dev ? 'com.vimperium.browser.dev' : 'com.vimperium.browser')
}
