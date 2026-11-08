// Patches we apply to `node_modules/electron-chrome-extensions/dist/cjs/index.js`
// at process startup, BEFORE the lib is required anywhere in the main bundle.
//
// Why a side-effect module: the lib is imported via the top-level
// `import { ElectronChromeExtensions } from 'electron-chrome-extensions'`
// in src/main/index.ts and src/main/chrome-extensions-bridge.ts. By the
// time `app.whenReady` fires, Node has already cached the lib's compiled
// JS in `require.cache` — modifying the file on disk only takes effect
// on the NEXT run, which is what bit us when we tried to patch the
// PermissionsAPI throws from inside the ready handler.
//
// To apply patches in the SAME run, this module:
//   1. Lives in a file that does its work at module-load time
//   2. Is imported at the very top of `src/main/index.ts` (BEFORE the
//      first import that pulls in `electron-chrome-extensions`)
//
// All patches are idempotent — top-of-file magic markers prevent
// re-application across runs.
//
// Patches:
//
//   1. PermissionsAPI.request — the lib mirrors Chrome's contract that
//      only permissions in `manifest.optional_permissions` can be
//      requested at runtime, throwing "Permissions request includes
//      undeclared permission" otherwise. Browsec's Health Check page
//      calls chrome.permissions.request({permissions: [<not declared>]})
//      and the throw bubbles up. We always grant via
//      `store.requestPermissions` (returns true unconditionally), so
//      the upstream check defeats its own grant flow. Replace the two
//      throw sites with comments.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../log'
import { LEGACY_LIB_PATCH_MARKER } from './legacy-names'

const LIB_PATCH_MARKER = '// __VIMPERIUM_LIB_PATCH_V1__'

function locateLibIndex(): string | null {
  const candidates: string[] = []
  try {
    const resolved = require.resolve('electron-chrome-extensions')
    candidates.push(resolved)
    candidates.push(join(dirname(resolved), 'index.js'))
  } catch {
    // require.resolve may fail in unusual setups; fall through to fixed paths.
  }
  candidates.push(
    join(__dirname, '..', '..', 'node_modules', 'electron-chrome-extensions', 'dist', 'cjs', 'index.js'),
    join(process.cwd(), 'node_modules', 'electron-chrome-extensions', 'dist', 'cjs', 'index.js'),
  )
  const probeFailures: Array<{ candidate: string; err: string }> = []
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch (err) {
      probeFailures.push({ candidate: c, err: String(err) })
    }
  }
  if (probeFailures.length > 0) {
    log.warn('extensions: lib-patch existsSync probe failures', { tried: probeFailures })
  }
  return null
}

function patchPermissionsAPI(): void {
  const libPath = locateLibIndex()
  if (!libPath) {
    log.warn('extensions: lib-patch could not locate node_modules/electron-chrome-extensions/dist/cjs/index.js')
    return
  }
  let source: string
  try {
    source = readFileSync(libPath, 'utf-8')
  } catch (err) {
    log.warn('extensions: lib-patch cannot read index.js', { path: libPath, err: String(err) })
    return
  }
  if (source.startsWith(LIB_PATCH_MARKER)) return
  // Newbro patched this file already (its throw sites are gone): re-mark
  // it as ours instead of reporting the library as drifted.
  if (source.startsWith(LEGACY_LIB_PATCH_MARKER + '\n')) {
    try {
      writeFileSync(libPath, LIB_PATCH_MARKER + source.slice(LEGACY_LIB_PATCH_MARKER.length))
      log.info('extensions: lib-patch re-marked (Newbro had applied it)', { path: libPath })
    } catch (err) {
      log.warn('extensions: lib-patch cannot re-mark index.js', { path: libPath, err: String(err) })
    }
    return
  }

  const before = source
  source = source.replace(
    'throw new Error("Permissions request includes undeclared permission");',
    '/* permission allow-list disabled by Vimperium */',
  )
  source = source.replace(
    'throw new Error("Permissions request includes undeclared origin");',
    '/* origin allow-list disabled by Vimperium */',
  )
  if (source === before) {
    log.warn('extensions: lib-patch — neither throw site found', { path: libPath })
    return
  }
  source = LIB_PATCH_MARKER + '\n' + source
  try {
    writeFileSync(libPath, source)
    log.info('extensions: lib-patch applied (PermissionsAPI throws disabled)', { path: libPath })
  } catch (err) {
    log.warn('extensions: lib-patch cannot write index.js', { path: libPath, err: String(err) })
  }
}

patchPermissionsAPI()
