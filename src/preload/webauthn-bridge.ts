// Page side of Newbro's passkeys (main/webauthn.ts), macOS only.
//
// Replaces navigator.credentials.create / get for publicKey requests in the
// page's main world and carries them to main over IPC. Main derives the
// origin from this frame itself, so a page can't speak for another site, and
// main builds the client data. Everything else — password and federated
// credentials, requests aimed at a security key — goes to Chromium's own
// implementation.

import { contextBridge, ipcRenderer } from 'electron'

const bridgeGlobal = globalThis as typeof globalThis & { __newbroWebAuthnInstalled?: boolean }

export function installWebAuthnBridge(): void {
  if (process.platform !== 'darwin') return
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  // The preload can run twice in one frame (webPreferences + session).
  if (bridgeGlobal.__newbroWebAuthnInstalled) return
  bridgeGlobal.__newbroWebAuthnInstalled = true

  const cb = contextBridge as typeof contextBridge & {
    executeInMainWorld?: (spec: { func: (...a: never[]) => void; args?: unknown[] }) => void
  }
  if (typeof cb.executeInMainWorld !== 'function') {
    // eslint-disable-next-line no-console
    console.log('[newbro-webauthn] contextBridge.executeInMainWorld is missing; passkeys are off')
    return
  }
  // These run here, in the isolated world, when the page's override calls them.
  const request = (kind: 'create' | 'get', req: unknown): Promise<unknown> => {
    // Chromium refuses ceremonies from documents the user can't see.
    if (document.visibilityState !== 'visible') {
      return Promise.resolve({ ok: false, name: 'NotAllowedError', message: 'The document is not visible.' })
    }
    return ipcRenderer.invoke(`webauthn:${kind}`, req)
  }
  const cancel = (requestId: string): void => {
    ipcRenderer.send('webauthn:cancel', requestId)
  }
  const available = (): Promise<boolean> => ipcRenderer.invoke('webauthn:available')
  try {
    cb.executeInMainWorld({ func: mainWorldWebAuthn as (...a: never[]) => void, args: [request, cancel, available] })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[newbro-webauthn] main-world install failed:', err)
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// SERIALIZED into the page's main world — must stay self-contained (no
// references to anything outside its own body).
function mainWorldWebAuthn(
  request: (kind: 'create' | 'get', req: Record<string, unknown>) => Promise<any>,
  cancel: (requestId: string) => void,
  available: () => Promise<boolean>,
): void {
  const w = window as any
  const PKC = w.PublicKeyCredential
  const Container = w.CredentialsContainer
  if (typeof PKC !== 'function' || typeof Container !== 'function' || !navigator.credentials) return
  const proto = Container.prototype
  const nativeCreate = proto.create
  const nativeGet = proto.get
  // Overrides are Proxies of the native functions: name, length and
  // toString stay native-looking for sign-in scripts that probe them.
  const override = (native: any, impl: (self: any, args: any[]) => any): any =>
    typeof native === 'function'
      ? new Proxy(native, { apply: (_target, self, args) => impl(self, args) })
      : function (this: any, ...args: any[]) { return impl(this, args) }

  const bytesOf = (value: any, field: string): Uint8Array => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError(`Failed to read the '${field}' property: The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.`)
  }
  const toB64u = (value: any, field: string): string => {
    const view = bytesOf(value, field)
    let binary = ''
    for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const fromB64u = (value: string): ArrayBuffer => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out.buffer
  }
  const descriptors = (list: any, field: string): Array<{ id: string; transports?: string[] }> =>
    Array.from(list || [], (d: any) => ({
      id: toB64u(d && d.id, `${field}.id`),
      transports: Array.isArray(d && d.transports) ? d.transports.map(String) : undefined,
    }))
  const optionalString = (value: any): string | undefined => value === undefined ? undefined : String(value)
  const abortReason = (signal: any): any =>
    signal.reason !== undefined ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')

  // Results become real-looking PublicKeyCredential objects: the native
  // prototypes (instanceof, toStringTag) with own data properties on top.
  const own = (target: any, props: Record<string, unknown>): any => {
    for (const key of Object.keys(props)) {
      Object.defineProperty(target, key, { value: props[key], enumerable: true, configurable: true })
    }
    return target
  }
  const credential = (res: any, response: any, responseJSON: Record<string, unknown>): any => {
    const extensions = () => JSON.parse(JSON.stringify(res.extensions || {}))
    return own(Object.create(PKC.prototype), {
      id: res.id,
      rawId: fromB64u(res.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
      getClientExtensionResults: extensions,
      toJSON: () => ({
        id: res.id,
        rawId: res.id,
        response: responseJSON,
        authenticatorAttachment: 'platform',
        clientExtensionResults: extensions(),
        type: 'public-key',
      }),
    })
  }
  const attestation = (res: any): any => {
    const authData = fromB64u(res.authenticatorData)
    const publicKey = fromB64u(res.publicKey)
    const response = own(Object.create(w.AuthenticatorAttestationResponse.prototype), {
      clientDataJSON: fromB64u(res.clientDataJSON),
      attestationObject: fromB64u(res.attestationObject),
      getTransports: () => res.transports.slice(),
      getAuthenticatorData: () => authData.slice(0),
      getPublicKey: () => publicKey.slice(0),
      getPublicKeyAlgorithm: () => res.publicKeyAlgorithm,
    })
    return credential(res, response, {
      clientDataJSON: res.clientDataJSON,
      authenticatorData: res.authenticatorData,
      transports: res.transports.slice(),
      publicKey: res.publicKey,
      publicKeyAlgorithm: res.publicKeyAlgorithm,
      attestationObject: res.attestationObject,
    })
  }
  const assertion = (res: any): any => {
    const response = own(Object.create(w.AuthenticatorAssertionResponse.prototype), {
      clientDataJSON: fromB64u(res.clientDataJSON),
      authenticatorData: fromB64u(res.authenticatorData),
      signature: fromB64u(res.signature),
      userHandle: res.userHandle ? fromB64u(res.userHandle) : null,
    })
    return credential(res, response, {
      clientDataJSON: res.clientDataJSON,
      authenticatorData: res.authenticatorData,
      signature: res.signature,
      userHandle: res.userHandle || undefined,
    })
  }

  let sequence = 0
  const ceremony = (kind: 'create' | 'get', req: Record<string, unknown>, signal: any, timeout: any): Promise<any> =>
    new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortReason(signal))
        return
      }
      const requestId = `${Date.now().toString(36)}-${++sequence}`
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (fn: (value: any) => void, value: any): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const onAbort = (): void => {
        cancel(requestId)
        settle(reject, abortReason(signal))
      }
      if (signal) signal.addEventListener('abort', onAbort)
      // Chromium's bounds for the page's timeout: 10 s to 10 min, 5 min by default.
      const ms = typeof timeout === 'number' && timeout > 0 ? Math.min(Math.max(timeout, 10_000), 600_000) : 300_000
      timer = setTimeout(() => {
        cancel(requestId)
        settle(reject, new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'))
      }, ms)
      request(kind, { ...req, requestId }).then((res) => {
        if (res && (res.ok || res.native)) settle(resolve, res)
        else if (res && res.name === 'TypeError') settle(reject, new TypeError(res.message))
        else settle(reject, new DOMException((res && res.message) || 'The operation either timed out or was not allowed.', (res && res.name) || 'NotAllowedError'))
      }, (err) => settle(reject, new DOMException(String((err && err.message) || err), 'NotAllowedError')))
    })

  proto.create = override(nativeCreate, (self, args) => {
    const options = args[0]
    const pk = options && options.publicKey
    if (!pk) return Reflect.apply(nativeCreate, self, args)
    const selection = pk.authenticatorSelection || {}
    const hints = Array.isArray(pk.hints) ? pk.hints : []
    if (selection.authenticatorAttachment === 'cross-platform' || hints[0] === 'security-key') {
      return Reflect.apply(nativeCreate, self, args)
    }
    let req: Record<string, unknown>
    try {
      req = {
        challenge: toB64u(pk.challenge, 'publicKey.challenge'),
        rp: { id: optionalString(pk.rp && pk.rp.id), name: String((pk.rp && pk.rp.name) ?? '') },
        user: {
          id: toB64u(pk.user && pk.user.id, 'publicKey.user.id'),
          name: String((pk.user && pk.user.name) ?? ''),
          displayName: String((pk.user && pk.user.displayName) ?? ''),
        },
        pubKeyCredParams: Array.from(pk.pubKeyCredParams || [], (p: any) => ({ type: String(p && p.type), alg: Number(p && p.alg) })),
        excludeCredentials: descriptors(pk.excludeCredentials, 'publicKey.excludeCredentials'),
        userVerification: optionalString(selection.userVerification),
        credProps: !!(pk.extensions && pk.extensions.credProps),
      }
    } catch (err) {
      return Promise.reject(err)
    }
    return ceremony('create', req, options.signal, pk.timeout)
      .then((res) => res.native ? Reflect.apply(nativeCreate, self, args) : attestation(res))
  })

  proto.get = override(nativeGet, (self, args) => {
    const options = args[0]
    const pk = options && options.publicKey
    if (!pk) return Reflect.apply(nativeGet, self, args)
    const hints = Array.isArray(pk.hints) ? pk.hints : []
    if (hints[0] === 'security-key') return Reflect.apply(nativeGet, self, args)
    // No passkey autofill (isConditionalMediationAvailable says so): a page
    // that asks anyway waits, as it would for a passkey never picked.
    if (options.mediation === 'conditional') {
      const signal = options.signal
      return new Promise((_resolve, reject) => {
        if (!signal) return
        if (signal.aborted) reject(abortReason(signal))
        else signal.addEventListener('abort', () => reject(abortReason(signal)), { once: true })
      })
    }
    let req: Record<string, unknown>
    try {
      req = {
        challenge: toB64u(pk.challenge, 'publicKey.challenge'),
        rpId: optionalString(pk.rpId),
        allowCredentials: descriptors(pk.allowCredentials, 'publicKey.allowCredentials'),
        userVerification: optionalString(pk.userVerification),
      }
    } catch (err) {
      return Promise.reject(err)
    }
    return ceremony('get', req, options.signal, pk.timeout)
      .then((res) => res.native ? Reflect.apply(nativeGet, self, args) : assertion(res))
  })

  PKC.isUserVerifyingPlatformAuthenticatorAvailable = override(PKC.isUserVerifyingPlatformAuthenticatorAvailable, () => available())
  PKC.isConditionalMediationAvailable = override(PKC.isConditionalMediationAvailable, () => Promise.resolve(false))
  if (typeof PKC.getClientCapabilities === 'function') {
    const nativeCapabilities = PKC.getClientCapabilities
    PKC.getClientCapabilities = override(nativeCapabilities, () =>
      Promise.all([Reflect.apply(nativeCapabilities, PKC, []) as Promise<Record<string, boolean>>, available()]).then(([capabilities, platform]) => ({
        ...capabilities,
        conditionalCreate: false,
        conditionalGet: false,
        hybridTransport: false,
        passkeyPlatformAuthenticator: platform,
        userVerifyingPlatformAuthenticator: platform,
      })))
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
