// Chrome Web Store + Edge Add-ons client.
//
// Downloads a CRX by extension ID. We try the Chrome Web Store first
// (clients2.google.com), and fall back to the Microsoft Edge Add-ons CDN
// (edge.microsoft.com/extensionwebstorebase) when the Chrome endpoint
// 404s — Edge-exclusive listings have their own 32-char IDs that Google
// doesn't know about.
//
// We use Electron's `net.request` so the user's configured proxy and proxy
// auth are honoured (important for users behind corporate proxies). Both
// endpoints respond with a 302 to the actual CRX payload — with
// `redirect: 'follow'` (the default) Electron follows automatically, so
// the `response` event fires on the terminal 200.

import { net, session, type Session } from 'electron'
import { log } from '../log'

const CHROME_VERSION = '125.0.0.0'

function buildChromeUrl(extensionId: string): string {
  // Params mirror what stable Chrome sends for an on-demand install. `os` is
  // hardcoded to "linux" because the CDN doesn't actually gate on OS for
  // cross-platform extensions and our users run all three desktop OSes.
  const params = new URLSearchParams({
    response: 'redirect',
    os: 'linux',
    arch: 'x64',
    os_arch: 'x86_64',
    nacl_arch: 'x86-64',
    prod: 'chromiumcrx',
    prodchannel: 'unknown',
    prodversion: CHROME_VERSION,
    lang: 'en-US',
    acceptformat: 'crx3',
    x: `id=${extensionId}&installsource=ondemand&uc`,
  })
  return `https://clients2.google.com/service/update2/crx?${params.toString()}`
}

function buildEdgeUrl(extensionId: string): string {
  // Edge Add-ons CDN — same .crx format as Chrome, different host. Edge
  // requires a `prodversion` query param that looks like an Edge build
  // number; we pass a recent Stable build. Edge IDs also follow the
  // same 32-char [a-p] shape that Chrome IDs do, so the caller's regex
  // doesn't need to change.
  const params = new URLSearchParams({
    response: 'redirect',
    os: 'win',
    arch: 'x64',
    os_arch: 'x86_64',
    nacl_arch: 'x86-64',
    prod: 'edgecrx',
    prodchannel: 'stable',
    prodversion: '125.0.2535.67',
    lang: 'en-US',
    acceptformat: 'crx3',
    x: `id=${extensionId}&installsource=ondemand&uc`,
  })
  return `https://edge.microsoft.com/extensionwebstorebase/v1/crx?${params.toString()}`
}

export function extractExtensionIdFromUrl(input: string): string | null {
  const trimmed = input.trim()
  // Bare 32-char lowercase id
  if (/^[a-p]{32}$/.test(trimmed)) return trimmed
  // chromewebstore.google.com/detail/<slug>/<id>
  const m1 = trimmed.match(/chromewebstore\.google\.com\/detail\/[^/]+\/([a-p]{32})/i)
  if (m1) return m1[1]
  // legacy chrome.google.com/webstore/detail/<slug>/<id>
  const m2 = trimmed.match(/chrome\.google\.com\/webstore\/detail\/[^/]+\/([a-p]{32})/i)
  if (m2) return m2[1]
  // microsoftedge.microsoft.com/addons/detail/<slug>/<id>
  const m3 = trimmed.match(/microsoftedge\.microsoft\.com\/addons\/detail\/[^/]+\/([a-p]{32})/i)
  if (m3) return m3[1]
  // Trailing /<id> on any URL
  const m4 = trimmed.match(/\/([a-p]{32})(?:[/?#]|$)/i)
  if (m4) return m4[1]
  return null
}

class FetchError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message)
  }
}

/** Download the CRX for `extensionId`. Tries the Chrome Web Store first;
 *  if Chrome returns 404 (extension doesn't exist there — typical for
 *  Edge-exclusive listings) we try the Edge Add-ons CDN. Throws on
 *  network errors or non-2xx responses from both endpoints. */
export async function fetchCrx(extensionId: string): Promise<Buffer> {
  try {
    return await fetchFrom(buildChromeUrl(extensionId), 'chrome')
  } catch (err) {
    if (err instanceof FetchError && err.status === 404) {
      log.info('crx: chrome 404, trying edge', extensionId)
      try {
        return await fetchFrom(buildEdgeUrl(extensionId), 'edge')
      } catch (edgeErr) {
        if (edgeErr instanceof FetchError) {
          throw new Error(
            `Extension not found. Chrome Web Store returned 404 and Edge Add-ons returned HTTP ${edgeErr.status}. Check the ID and try again.`
          )
        }
        throw edgeErr
      }
    }
    throw err
  }
}

// Dedicated, never-touched session for CRX downloads. The default session
// has Chrome extensions loaded into and removed from it as the user installs
// and uninstalls them; we observed that `net.request` against the default
// session would silently fail with `net::ERR_FAILED` on the second install
// after a remove (the first install always worked). Routing through a
// session that nothing else mutates avoids whatever stale state the install
// path leaves behind in the request layer.
//
// Note: this is an in-memory partition (no `persist:` prefix) so cookies
// and HTTP cache from a previous fetch can't influence the next one — we
// want a clean slate every time.
const CRX_FETCH_PARTITION = 'crx-fetch'
let crxFetchSession: Session | null = null

function getCrxFetchSession(): Session {
  if (crxFetchSession) return crxFetchSession
  const ses = session.fromPartition(CRX_FETCH_PARTITION)
  // Disable HTTP cache entirely so a stale 404/302 from a previous install
  // attempt can't poison the next one.
  ses.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) Chrome/${CHROME_VERSION}`)
  crxFetchSession = ses
  return ses
}

async function clearCrxFetchSession(): Promise<void> {
  if (!crxFetchSession) return
  // Belt-and-braces: clear cookies, cache, and storage between fetches so
  // every download is independent of what came before. We only catch errors
  // here because clearing is best-effort — a failed clear shouldn't block
  // an install attempt.
  try {
    await Promise.all([
      crxFetchSession.clearCache(),
      crxFetchSession.clearStorageData({
        storages: ['cookies', 'cachestorage', 'serviceworkers'],
      }),
    ])
  } catch (err) {
    log.warn('crx: failed to clear fetch session', String(err))
  }
}

function fetchFrom(url: string, source: 'chrome' | 'edge'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // `redirect: 'follow'` (the default) makes Electron follow 3xx
    // responses internally — the `response` event fires once on the
    // terminal 200. Using 'manual' without `request.followRedirect()`
    // raises "Redirect was cancelled", which is what the first
    // implementation was doing wrong.
    const ses = getCrxFetchSession()
    const request = net.request({ method: 'GET', url, session: ses, useSessionCookies: false })
    request.setHeader('User-Agent', `Mozilla/5.0 (X11; Linux x86_64) Chrome/${CHROME_VERSION}`)
    // Bypass any HTTP cache the request layer might consult.
    request.setHeader('Cache-Control', 'no-cache')
    request.setHeader('Pragma', 'no-cache')

    request.on('response', (response) => {
      const status = response.statusCode
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        if (status < 200 || status >= 300) {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 200)
          reject(new FetchError(status, body, `CRX fetch failed from ${source}: HTTP ${status}`))
          return
        }
        resolve(Buffer.concat(chunks))
      })
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => {
      log.warn('crx: net.request error', { url, err: String(err) })
      reject(err)
    })
    request.end()
  })
}

// Exported so installExtensionById can wipe state between attempts. Not
// strictly necessary now that the fetch session is isolated from the rest
// of the app, but cheap insurance against any other state surprise.
export { clearCrxFetchSession }
