// Registry for chrome.userScripts-registered scripts and the injection
// pipeline that actually runs them on matching tab navigations.
//
// Why this lives in main: chrome.userScripts is an MV3 API Electron 41
// doesn't ship. The shim we prepend into each extension's
// background.js (src/main/extensions/sw-shim.ts) intercepts the
// register/update/unregister calls and forwards their payload here via
// the partition's webRequest hook (src/main/index.ts). Storing the
// payload in main lets us inject at the right place, the right time,
// and from outside the extension's own JS world — which is necessary
// because the SW preload mechanism doesn't fire for chrome-extension
// service workers in Electron 41 (verified empirically with the
// "shim loaded preload-start" log being absent for SW contexts).
//
// Match-pattern matching follows Chrome's spec for the subset every
// userscript engine cares about:
//   * scheme: '*' | 'http' | 'https' | 'file' | 'ftp'
//   * host:   '*' | '*.<host>' | '<host>'
//   * path:   any glob with '*' as the only wildcard
// `<all_urls>` is supported as a top-level shorthand. We don't try to
// emulate every spec corner — the goal is "Tampermonkey's matches
// resolve the way real Chrome does for the inputs users actually
// type", not formal completeness.

import type { WebContents } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log } from '../log'
import { getExtensionEntry } from './manager'

interface UserScriptJsSource {
  /** Inline JS to inject. */
  code?: string
  /** Path inside the extension to load and inject. Relative to the
   *  extension root. We don't currently load these from disk — every
   *  userscript engine we've seen passes inline code instead. */
  file?: string
}

export interface RegisteredUserScript {
  id: string
  matches?: string[]
  excludeMatches?: string[]
  /** When true, run inside iframes too. Defaults to false. */
  allFrames?: boolean
  /** Chrome runAt: 'document_start' | 'document_end' | 'document_idle'. */
  runAt?: 'document_start' | 'document_end' | 'document_idle'
  /** 'USER_SCRIPT' (isolated) | 'MAIN' (page world). We always inject
   *  into MAIN because Electron's executeJavaScript only addresses the
   *  main world; treat USER_SCRIPT as an alias. */
  world?: 'USER_SCRIPT' | 'MAIN'
  js?: UserScriptJsSource[]
}

interface PartitionRegistry {
  /** extensionId → id → script. Two extensions can share a script id
   *  without colliding because the outer key is the extension. */
  byExtension: Map<string, Map<string, RegisteredUserScript>>
}

const registries = new Map<string, PartitionRegistry>()

function getRegistry(partition: string): PartitionRegistry {
  let r = registries.get(partition)
  if (!r) {
    r = { byExtension: new Map() }
    registries.set(partition, r)
  }
  return r
}

export function registerUserScripts(
  partition: string,
  extensionId: string,
  scripts: RegisteredUserScript[],
): void {
  const reg = getRegistry(partition)
  let map = reg.byExtension.get(extensionId)
  if (!map) {
    map = new Map()
    reg.byExtension.set(extensionId, map)
  }
  for (const s of scripts) {
    if (!s || typeof s.id !== 'string' || s.id.length === 0) continue
    map.set(s.id, s)
  }
  // Detailed log so the next test run shows exactly what Tampermonkey
  // forwarded — id, matches, runAt, world, and the size of the
  // injected JS body. If the user's script doesn't appear here, then
  // Tampermonkey isn't routing through chrome.userScripts.register at
  // all (probably uses chrome.scripting.executeScript instead) and we
  // need a different polyfill path.
  for (const s of scripts) {
    if (!s) continue
    const totalCodeLen = Array.isArray(s.js)
      ? s.js.reduce((n, j) => n + (typeof j.code === 'string' ? j.code.length : 0), 0)
      : 0
    log.info('userscripts: register entry', {
      partition,
      extensionId,
      id: s.id,
      matches: s.matches,
      excludeMatches: s.excludeMatches,
      runAt: s.runAt,
      world: s.world,
      allFrames: s.allFrames,
      jsCount: Array.isArray(s.js) ? s.js.length : 0,
      jsCodeLen: totalCodeLen,
    })
  }
  log.info('userscripts: registered', {
    partition,
    extensionId,
    count: scripts.length,
    total: map.size,
  })
}

export function unregisterUserScripts(
  partition: string,
  extensionId: string,
  ids: string[] | null,
): void {
  const reg = getRegistry(partition)
  const map = reg.byExtension.get(extensionId)
  if (!map) return
  if (!ids) {
    map.clear()
  } else {
    for (const id of ids) map.delete(id)
  }
  log.info('userscripts: unregistered', {
    partition,
    extensionId,
    cleared: !ids,
    ids: ids?.length ?? 0,
    remaining: map.size,
  })
}

/** Translate a Chrome match pattern to a regex that the URL of a tab
 *  can be tested against. Returns null for malformed patterns so the
 *  caller can warn and skip without crashing the partition. */
function patternToRegex(pattern: string): RegExp | null {
  if (pattern === '<all_urls>') return /^(https?|ftp|file):\/\//i
  // scheme://host/path
  const m = pattern.match(/^(\*|https?|ftp|file):\/\/([^/]+)(\/.*)$/)
  if (!m) return null
  const [, scheme, host, path] = m
  let re = '^'
  re += scheme === '*' ? '(?:https?)' : scheme
  re += '://'
  if (host === '*') {
    re += '[^/]+'
  } else if (host.startsWith('*.')) {
    const suffix = host.slice(2)
    if (suffix.includes('*')) return null
    // Match suffix OR <something>.suffix.
    re += '(?:[^/]+\\.)?' + suffix.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  } else {
    if (host.includes('*')) return null
    re += host.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // Path portion: only '*' is a wildcard.
  for (const ch of path) {
    if (ch === '*') re += '.*'
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += '\\' + ch
    else re += ch
  }
  re += '$'
  try { return new RegExp(re, 'i') } catch { return null }
}

const patternCache = new Map<string, RegExp | null>()
function compilePattern(pattern: string): RegExp | null {
  if (!patternCache.has(pattern)) patternCache.set(pattern, patternToRegex(pattern))
  return patternCache.get(pattern) ?? null
}

function matchesAny(patterns: string[] | undefined, url: string): boolean {
  if (!patterns || patterns.length === 0) return false
  for (const p of patterns) {
    const re = compilePattern(p)
    if (re && re.test(url)) return true
  }
  return false
}

/** Run every userscript whose matches accept this URL on this tab.
 *  Called from tab-views once the tab's WebContents is in the right
 *  state for the requested runAt. We don't support per-frame injection
 *  yet (allFrames is honoured only for the main frame); adding that
 *  needs a stable iframe-hosting story which we don't have today.
 *
 *  Injection world: we use executeJavaScriptInIsolatedWorld with a
 *  unique world id derived from the extension id so each extension's
 *  scripts run in a dedicated isolated context per page — the same
 *  shape Chrome's USER_SCRIPT world has. This avoids polluting the
 *  page's main world AND keeps two different extensions' scripts from
 *  trampling each other's globals. The world id is the lower 32 bits
 *  of a hash of the extension id, capped well above 100 (Electron
 *  reserves the low ids for content_scripts). */
function worldIdForExtension(extensionId: string): number {
  // Cheap deterministic hash. Doesn't need to be cryptographic — just
  // collision-resistant across the handful of extensions a user has.
  let h = 0
  for (let i = 0; i < extensionId.length; i++) {
    h = ((h << 5) - h + extensionId.charCodeAt(i)) | 0
  }
  // Map into [1000, 1_000_999]. Worlds 0–99 are reserved by Chromium
  // for content scripts; staying high above that avoids any clash.
  return 1000 + Math.abs(h) % 1000
}

export function injectMatchingUserScripts(
  partition: string,
  url: string,
  runAt: 'document_start' | 'document_end' | 'document_idle',
  wc: WebContents,
): void {
  const reg = registries.get(partition)
  const totalScripts = reg
    ? Array.from(reg.byExtension.values()).reduce((n, m) => n + m.size, 0)
    : 0
  log.info('userscripts: navigation', { partition, url, runAt, totalScripts })
  if (!reg || reg.byExtension.size === 0) return
  if (!url || !/^(https?|ftp|file):/i.test(url)) return

  for (const [extensionId, scripts] of reg.byExtension) {
    for (const script of scripts.values()) {
      const scriptRunAt = script.runAt ?? 'document_idle'
      if (scriptRunAt !== runAt) {
        log.info('userscripts: skip (runAt mismatch)', {
          extensionId, id: script.id, scriptRunAt, runAt,
        })
        continue
      }
      const m1 = matchesAny(script.matches, url)
      if (!m1) {
        log.info('userscripts: skip (matches mismatch)', {
          extensionId, id: script.id, url, matches: script.matches,
        })
        continue
      }
      if (matchesAny(script.excludeMatches, url)) {
        log.info('userscripts: skip (excluded)', {
          extensionId, id: script.id, url, excludeMatches: script.excludeMatches,
        })
        continue
      }
      if (!Array.isArray(script.js) || script.js.length === 0) {
        log.info('userscripts: skip (no js sources)', { extensionId, id: script.id })
        continue
      }
      // js[] entries can carry inline `code` OR a `file` path
      // relative to the extension root. Tampermonkey 5.4 registers
      // its bootstrap scripts with `file` only, so we must read the
      // file content here. Reads are cached at the per-script level
      // because the same script body gets re-injected on every
      // navigation.
      const code = script.js
        .map((src) => loadJsSource(extensionId, src))
        .filter((s) => s.length > 0)
        .join('\n;\n')
      if (!code) {
        log.info('userscripts: skip (empty code body)', {
          extensionId,
          id: script.id,
          jsLen: script.js.length,
          jsShape: script.js.map((s) => ({ hasCode: typeof s.code === 'string', file: s.file ?? null })),
        })
        continue
      }
      // Wrap in an IIFE so the script's top-level vars stay scoped to
      // this invocation. Tampermonkey already wraps each user script
      // in its own GM_* sandbox before passing it to register(), so
      // this is belt-and-braces — but cheap insurance.
      const wrapped = '(function(){' + code + '\n;})();'
      const world = script.world === 'MAIN' ? 0 : worldIdForExtension(extensionId)
      log.info('userscripts: injecting', {
        partition,
        extensionId,
        id: script.id,
        url,
        runAt,
        world,
      })
      try {
        if (world === 0) {
          wc.executeJavaScript(wrapped, true).catch((err) => {
            log.warn('userscripts: injection failed', {
              partition, extensionId, id: script.id, url, err: String(err),
            })
          })
        } else {
          // executeJavaScriptInIsolatedWorld is sync-style — takes an
          // array of scripts, no Promise return on every Electron
          // version, so wrap in try/catch.
          ;(wc as unknown as {
            executeJavaScriptInIsolatedWorld: (
              worldId: number,
              scripts: { code: string }[],
            ) => Promise<unknown> | void
          }).executeJavaScriptInIsolatedWorld(world, [{ code: wrapped }])
        }
      } catch (err) {
        log.warn('userscripts: injection failed', {
          partition, extensionId, id: script.id, url, err: String(err),
        })
      }
    }
  }
}

/** Drop every registered script for a given extension. Called when the
 *  extension is uninstalled / disabled so we don't keep injecting after
 *  the user clearly doesn't want it. */
export function clearUserScriptsForExtension(extensionId: string): void {
  for (const reg of registries.values()) {
    reg.byExtension.delete(extensionId)
  }
}

// Cache loaded file contents — Tampermonkey's bootstrap files don't
// change at runtime, so re-reading them on every navigation is just
// wasted I/O. Keyed by absolute path.
const fileSourceCache = new Map<string, string>()

/** Resolve a single js[] source entry to its actual JavaScript body.
 *  - { code: '...' } → returns the inline code as-is.
 *  - { file: 'path/inside/extension.js' } → reads from the
 *    extension's on-disk root via getExtensionEntry(extensionId).path.
 *  - Anything else → empty string (caller filters out empties).
 *
 *  Path-traversal-safe: relative paths are resolved against the
 *  extension root and rejected if they escape it. */
function loadJsSource(extensionId: string, src: UserScriptJsSource): string {
  if (typeof src.code === 'string' && src.code.length > 0) return src.code
  if (typeof src.file !== 'string' || src.file.length === 0) return ''
  const entry = getExtensionEntry(extensionId)
  if (!entry || !entry.path) {
    log.warn('userscripts: cannot resolve js[].file — extension not registered', {
      extensionId,
      file: src.file,
    })
    return ''
  }
  // Strip leading slashes so join() doesn't treat src.file as absolute,
  // then check the resolved path stays inside the extension dir.
  const cleanRel = src.file.replace(/^\/+/, '')
  if (cleanRel.includes('..')) return ''
  const abs = join(entry.path, cleanRel)
  const root = resolve(entry.path)
  if (!resolve(abs).startsWith(root)) return ''
  if (fileSourceCache.has(abs)) return fileSourceCache.get(abs) ?? ''
  if (!existsSync(abs)) {
    log.warn('userscripts: js[].file missing on disk', { extensionId, abs })
    return ''
  }
  try {
    const text = readFileSync(abs, 'utf8')
    fileSourceCache.set(abs, text)
    return text
  } catch (err) {
    log.warn('userscripts: js[].file read failed', { extensionId, abs, err: String(err) })
    return ''
  }
}
