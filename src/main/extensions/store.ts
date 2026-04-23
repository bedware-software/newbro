// Chrome Web Store client.
//
// Downloads a CRX by extension ID. The public update endpoint follows HTTP
// 302 redirects to the actual CRX payload; we use Electron's `net.request`
// so the user's configured proxy and proxy auth are honoured (important
// for users behind corporate proxies).
//
// Caveat: Google's update service can rate-limit or refuse requests with
// unexpected product headers. We pretend to be a recent stable Chrome build
// and request crx3, which is what modern Chrome does.

import { net } from 'electron'
import { log } from '../log'

const CHROME_VERSION = '125.0.0.0'

function buildUpdateUrl(extensionId: string): string {
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
  // Trailing /<id> on any URL
  const m3 = trimmed.match(/\/([a-p]{32})(?:[/?#]|$)/i)
  if (m3) return m3[1]
  return null
}

/** Download the CRX for `extensionId`. Follows redirects and returns the
 *  full response body as a Buffer. Throws on non-2xx HTTP or network
 *  errors. Up to `maxRedirects` hops. */
export function fetchCrx(extensionId: string, maxRedirects = 5): Promise<Buffer> {
  const startUrl = buildUpdateUrl(extensionId)
  return followAndCollect(startUrl, maxRedirects)
}

function followAndCollect(url: string, hopsLeft: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      redirect: 'manual',
    })
    request.setHeader('User-Agent', `Mozilla/5.0 (X11; Linux x86_64) Chrome/${CHROME_VERSION}`)
    request.on('response', (response) => {
      const status = response.statusCode
      if (status >= 300 && status < 400) {
        const loc = response.headers['location']
        const next = Array.isArray(loc) ? loc[0] : loc
        if (!next) return reject(new Error(`CRX redirect without Location (${status})`))
        if (hopsLeft <= 0) return reject(new Error('CRX: too many redirects'))
        // Drain the redirect response body so the socket can close.
        response.on('data', () => {})
        response.on('end', () => {
          followAndCollect(next, hopsLeft - 1).then(resolve, reject)
        })
        return
      }
      if (status < 200 || status >= 300) {
        return reject(new Error(`CRX fetch failed: HTTP ${status}`))
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', (err) => reject(err))
    })
    request.on('error', (err) => {
      log.warn('crx: net.request error', { url, err: String(err) })
      reject(err)
    })
    request.end()
  })
}
