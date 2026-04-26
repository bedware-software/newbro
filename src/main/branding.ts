// Side-effect module — MUST be imported before any other internal module
// that constructs an `electron-store` (or otherwise reads
// `app.getPath('userData')`).
//
// `electron-store` resolves its target file at construction time using
// `app.getPath('userData')`, which is derived from `app.getName()`. If we
// don't rename the app first, every store gets pinned to
// `~/Library/Application Support/Newbro/` no matter what we do later in
// the entry point. Putting the rename in its own module imported FIRST in
// `src/main/index.ts` is what guarantees the dev / stable split actually
// affects on-disk paths.
//
// Why a different name in dev: a packaged production install and a dev
// run otherwise share the same userData/cache/cookies — installing or
// uninstalling extensions in one shows up in the other, profile state
// gets crossed, and tests trash the user's real data. Renaming to
// "Newbro Dev" routes everything to a sibling directory.

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'

export const APP_NAME = is.dev ? 'Newbro Dev' : 'Newbro'

// Must be set before app.whenReady() and before any electron-store
// instance is constructed. Both are guaranteed by importing this module
// as the first internal import in src/main/index.ts.
app.setName(APP_NAME)
