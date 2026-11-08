// The app was called Newbro, and the renderer kept its UI preferences in
// localStorage under keys named after it: newbro-sidebar-visible,
// -sidebar-width, -bookshelf-open, -bookshelf-width, -side-panel-width,
// -bangs-sort, -downloads-sort, -search-filter and -search-scope. The storage
// itself outlives the rename: it sits in userData, which moves as a whole, and
// the origin is the same (file:// in a packaged build, the dev server's in
// dev). So on the first Vimperium launch every preference is still there,
// only under its old key. This moves each `newbro-` key to its `vimperium-`
// name before the components read them. A value already under the new name
// wins. The old key goes once its value is safely copied, so later launches
// find nothing to move.
//
// It runs when imported, and main.tsx imports it first: components read their
// preferences while rendering, and a module that read one while loading would
// otherwise still beat the move.

import { log } from './log'

const LEGACY_KEY_PREFIX = 'newbro-'
const KEY_PREFIX = 'vimperium-'

/** Moves every `newbro-` key in `storage` to its `vimperium-` name. Returns
 *  how many values it copied. */
export function migrateLegacyStorage(storage?: Storage): number {
  let target: Storage
  const legacyKeys: string[] = []
  try {
    target = storage ?? window.localStorage
    // Collected first: removing keys while walking them shifts the indexes.
    for (let i = 0; i < target.length; i++) {
      const key = target.key(i)
      if (key !== null && key.startsWith(LEGACY_KEY_PREFIX)) legacyKeys.push(key)
    }
  } catch (err) {
    log.warn('legacy storage: could not read localStorage', String(err))
    return 0
  }

  let copied = 0
  for (const legacyKey of legacyKeys) {
    const key = KEY_PREFIX + legacyKey.slice(LEGACY_KEY_PREFIX.length)
    try {
      const value = target.getItem(legacyKey)
      if (value !== null && target.getItem(key) === null) {
        target.setItem(key, value)
        copied++
      }
      target.removeItem(legacyKey)
    } catch (err) {
      // The old key stays, so the next launch tries again.
      log.warn('legacy storage: could not move', legacyKey, String(err))
    }
  }
  if (legacyKeys.length > 0) {
    log.info('legacy storage: moved Newbro preferences', { found: legacyKeys.length, copied })
  }
  return copied
}

migrateLegacyStorage()
