// The address editor's view of a URL (components/UrlEditor.tsx): its blocks —
// protocol, domain, each path level, the parameters, the fragment — as
// character ranges of the text as typed, so they can be lit, selected,
// removed or replaced without reformatting the rest. Pure string work: the
// text being edited needn't be a valid URL.

export type BlockKind = 'proto' | 'domain' | 'path' | 'params' | 'fragment'

export interface UrlBlock {
  kind: BlockKind
  /** The quick-edit key that names it after an intent (c, r, y, p): p d
   *  1–9 s f — empty for path levels past the ninth. */
  key: string
  label: string
  /** [start, end) in the text. */
  start: number
  end: number
}

/** Quick-edit keys for the blocks that aren't path levels. */
export const BLOCK_KEYS: Record<Exclude<BlockKind, 'path'>, string> = {
  proto: 'p',
  domain: 'd',
  params: 's',
  fragment: 'f',
}

const MAX_PATH_KEYS = 9

interface Parts {
  /** Where the scheme ends (before ://), or -1 without one. */
  protoEnd: number
  hostStart: number
  hostEnd: number
  pathStart: number
  pathEnd: number
  /** Index of '?', or -1. */
  query: number
  /** Index of '#', or -1. */
  hash: number
}

function split(text: string): Parts {
  const proto = /^([a-zA-Z][a-zA-Z\d+.-]*):\/\//.exec(text)
  const protoEnd = proto ? proto[1].length : -1
  const hostStart = proto ? proto[0].length : 0
  const hash = text.indexOf('#')
  const beforeHash = hash === -1 ? text.length : hash
  const queryAt = text.indexOf('?')
  const query = queryAt !== -1 && queryAt < beforeHash ? queryAt : -1
  const beforeQuery = query === -1 ? beforeHash : query
  const slash = text.indexOf('/', hostStart)
  const hostEnd = slash !== -1 && slash < beforeQuery ? slash : beforeQuery
  return { protoEnd, hostStart, hostEnd, pathStart: hostEnd, pathEnd: beforeQuery, query, hash }
}

/** The text's blocks, in order. */
export function urlBlocks(text: string): UrlBlock[] {
  const p = split(text)
  const blocks: UrlBlock[] = []
  if (p.protoEnd > 0) blocks.push({ kind: 'proto', key: BLOCK_KEYS.proto, label: 'proto', start: 0, end: p.protoEnd })
  if (p.hostEnd > p.hostStart) blocks.push({ kind: 'domain', key: BLOCK_KEYS.domain, label: 'domain', start: p.hostStart, end: p.hostEnd })
  const segments: Array<[number, number]> = []
  let at = p.pathStart
  while (at < p.pathEnd) {
    // `at` sits on a '/'.
    const next = text.indexOf('/', at + 1)
    const end = next === -1 || next > p.pathEnd ? p.pathEnd : next
    if (end > at + 1) segments.push([at + 1, end])
    at = end
  }
  segments.forEach(([start, end], i, all) => {
    const label = all.length >= 2 && i === all.length - 1 ? 'resource' : `l${i + 1}`
    blocks.push({ kind: 'path', key: i < MAX_PATH_KEYS ? String(i + 1) : '', label, start, end })
  })
  if (p.query !== -1) {
    const end = p.hash === -1 ? text.length : p.hash
    blocks.push({ kind: 'params', key: BLOCK_KEYS.params, label: 'parameters', start: p.query + 1, end })
  }
  if (p.hash !== -1) blocks.push({ kind: 'fragment', key: BLOCK_KEYS.fragment, label: 'fragment', start: p.hash + 1, end: text.length })
  return blocks
}

export function blockByKey(text: string, key: string): UrlBlock | undefined {
  return key ? urlBlocks(text).find((b) => b.key === key) : undefined
}

/** The text without `block`, along with what holds it in place: a path
 *  level's '/', the '?' of the parameters, the '#' of the fragment, the
 *  '://' of the protocol. */
export function removeBlock(text: string, block: UrlBlock): string {
  switch (block.kind) {
    case 'proto': return text.slice(block.end + 3)
    case 'path': return text.slice(0, block.start - 1) + text.slice(block.end)
    case 'params':
    case 'fragment': return text.slice(0, block.start - 1) + text.slice(block.end)
    default: return text.slice(0, block.start) + text.slice(block.end)
  }
}

export function replaceBlock(text: string, block: UrlBlock, value: string): string {
  return text.slice(0, block.start) + value + text.slice(block.end)
}

/** One level up: the last path level goes, and the parameters and fragment
 *  with it — http://ya.ru/maps/cities/streets?a=b → http://ya.ru/maps/cities. */
export function upOneLevel(text: string): string {
  const p = split(text)
  const path = text.slice(p.pathStart, p.pathEnd).replace(/\/+$/, '')
  const cut = path.lastIndexOf('/')
  return text.slice(0, p.pathStart) + (cut > 0 ? path.slice(0, cut) : '')
}

/** Only where the site is: http://ya.ru/maps?a=b → http://ya.ru. */
export function siteOnly(text: string): string {
  return text.slice(0, split(text).hostEnd)
}
