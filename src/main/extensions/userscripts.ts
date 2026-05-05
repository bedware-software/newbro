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
import { log } from '../log'

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
 *  needs a stable iframe-hosting story which we don't have today. */
export function injectMatchingUserScripts(
  partition: string,
  url: string,
  runAt: 'document_start' | 'document_end' | 'document_idle',
  wc: WebContents,
): void {
  const reg = registries.get(partition)
  if (!reg || reg.byExtension.size === 0) return
  if (!url || !/^(https?|ftp|file):/i.test(url)) return

  for (const [extensionId, scripts] of reg.byExtension) {
    for (const script of scripts.values()) {
      const scriptRunAt = script.runAt ?? 'document_idle'
      if (scriptRunAt !== runAt) continue
      if (!matchesAny(script.matches, url)) continue
      if (matchesAny(script.excludeMatches, url)) continue
      if (!Array.isArray(script.js) || script.js.length === 0) continue
      const code = script.js
        .map((s) => (typeof s.code === 'string' ? s.code : ''))
        .filter((s) => s.length > 0)
        .join('\n;\n')
      if (!code) continue
      // Wrap in an IIFE so the script's top-level vars don't leak into
      // the page's main world. Tampermonkey already wraps each user
      // script in its own GM_* sandbox before passing it to register(),
      // so this is belt-and-braces — but cheap insurance against a
      // malformed inputs.
      const wrapped = '(function(){' + code + '\n;})();'
      wc.executeJavaScript(wrapped, true).catch((err) => {
        log.warn('userscripts: injection failed', {
          partition,
          extensionId,
          id: script.id,
          url,
          err: String(err),
        })
      })
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
