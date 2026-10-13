// The address editor's view of a URL (components/UrlEditor.tsx): its blocks —
// protocol, domain, port, each path level, the parameters, the fragment — as
// character ranges of the text as typed, so they can be lit, selected,
// removed or replaced without reformatting the rest. Pure string work: the
// text being edited needn't be a valid URL.

export type BlockKind = 'proto' | 'domain' | 'port' | 'path' | 'params' | 'fragment'

export interface UrlBlock {
  kind: BlockKind
  /** The quick-edit key that names it after an intent (c, r, y, p): h d n
   *  1–9 p f — empty for path levels past the ninth. */
  key: string
  label: string
  /** [start, end) in the text. */
  start: number
  end: number
}

/** Quick-edit keys for the blocks that aren't path levels: h for the
 *  protocol, which nearly always reads http(s). */
export const BLOCK_KEYS: Record<Exclude<BlockKind, 'path'>, string> = {
  proto: 'h',
  domain: 'd',
  port: 'n',
  params: 'p',
  fragment: 'f',
}

const BLOCK_LABELS: Record<Exclude<BlockKind, 'path'>, string> = {
  proto: 'protocol',
  domain: 'domain',
  port: 'port',
  params: 'parameters',
  fragment: 'fragment',
}

/** Whether `key` names a block (one the address may lack). */
export function isBlockKey(key: string): boolean {
  return /^[1-9]$/.test(key) || Object.values(BLOCK_KEYS).includes(key)
}

/** What the block `key` names is called: "port", "level 2". */
export function blockKeyLabel(key: string): string {
  if (/^[1-9]$/.test(key)) return `level ${key}`
  const kind = (Object.keys(BLOCK_KEYS) as Array<keyof typeof BLOCK_KEYS>).find((k) => BLOCK_KEYS[k] === key)
  return kind ? BLOCK_LABELS[kind] : key
}

const MAX_PATH_KEYS = 9

interface Parts {
  /** Where the scheme ends (before ://), or -1 without one. */
  protoEnd: number
  hostStart: number
  /** Index of the ':' before the port, or -1. */
  portColon: number
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
  // A port is digits after the host's last ':' — not one inside an IPv6
  // address in brackets, which ends with ']'.
  const port = /:\d*$/.exec(text.slice(hostStart, hostEnd))
  const portColon = port ? hostStart + port.index : -1
  return { protoEnd, hostStart, portColon, hostEnd, pathStart: hostEnd, pathEnd: beforeQuery, query, hash }
}

/** The text's blocks, in order. */
export function urlBlocks(text: string): UrlBlock[] {
  const p = split(text)
  const blocks: UrlBlock[] = []
  if (p.protoEnd > 0) blocks.push({ kind: 'proto', key: BLOCK_KEYS.proto, label: 'proto', start: 0, end: p.protoEnd })
  const domainEnd = p.portColon === -1 ? p.hostEnd : p.portColon
  if (domainEnd > p.hostStart) blocks.push({ kind: 'domain', key: BLOCK_KEYS.domain, label: 'domain', start: p.hostStart, end: domainEnd })
  if (p.portColon !== -1 && p.hostEnd > p.portColon + 1) {
    blocks.push({ kind: 'port', key: BLOCK_KEYS.port, label: 'port', start: p.portColon + 1, end: p.hostEnd })
  }
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
 *  level's '/', the ':' of the port, the '?' of the parameters, the '#' of
 *  the fragment, the '://' of the protocol. */
export function removeBlock(text: string, block: UrlBlock): string {
  switch (block.kind) {
    case 'proto': return text.slice(block.end + 3)
    case 'path':
    case 'port':
    case 'params':
    case 'fragment': return text.slice(0, block.start - 1) + text.slice(block.end)
    default: return text.slice(0, block.start) + text.slice(block.end)
  }
}

export function replaceBlock(text: string, block: UrlBlock, value: string): string {
  return text.slice(0, block.start) + value + text.slice(block.end)
}

/** Room for a block the address lacks, to type it in: the port's ':' after
 *  the host, the parameters' '?' before any fragment, the fragment's '#' at
 *  the end — with where typing goes. Null for a block that can't be
 *  started from nothing. */
export function startBlock(text: string, key: string): { text: string; at: number } | null {
  const p = split(text)
  switch (key) {
    case BLOCK_KEYS.port:
      if (p.hostEnd === p.hostStart) return null
      return { text: `${text.slice(0, p.hostEnd)}:${text.slice(p.hostEnd)}`, at: p.hostEnd + 1 }
    case BLOCK_KEYS.params:
      if (p.hash === -1) return { text: `${text}?`, at: text.length + 1 }
      return { text: `${text.slice(0, p.hash)}?${text.slice(p.hash)}`, at: p.hash + 1 }
    case BLOCK_KEYS.fragment:
      return { text: `${text}#`, at: text.length + 1 }
    default:
      return null
  }
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
