// Source for the shim we PREPEND directly into MV3 service-worker
// `background.js` files at install time.
//
// After the electron-chrome-extensions integration landed, most of the
// chrome.* APIs (tabs, windows, permissions, management, runtime
// messaging, action, contextMenus, cookies, etc.) come from the library's
// own session preload. The library does NOT implement
// chrome.userScripts (Tampermonkey/Violentmonkey gate userscript
// injection on this) or chrome.scripting.executeScript, so we still ship
// a polyfill for those and forward to main via newbro-ipc://.
//
// The reason this is prepended on disk rather than registered as a
// session preload: in Electron 41 we observed `registerPreloadScript`
// with `type: 'service-worker'` doesn't actually fire for
// chrome-extension service workers. Patching the file on disk is the
// only injection point that reliably runs before the extension's own
// SW code.
//
// Strict mode + IIFE so the shim never leaks identifiers into the
// extension's own global. Idempotent: a reinstall over a previously
// patched background.js sees the magic comment and skips. All overrides
// are conditional (`if (typeof X !== 'function')`) so we never clobber
// what the library OR Electron already provide.
//
// Versions:
//   V1–V6 — hand-rolled stubs for chrome.tabs, permissions, management,
//           runtime, action, scripting, userScripts. Mostly redundant
//           after V7.
//   V7 — slim to chrome.userScripts + chrome.scripting.executeScript
//        only; conditional overrides. electron-chrome-extensions
//        provides the rest of the surface.
//   V8 — force-overwrite chrome.userScripts.* and
//        chrome.scripting.executeScript (Electron 41 ships partial
//        stubs that throw or no-op; the typeof guard was skipping
//        our impl). Plus a shim-ran beacon so we can confirm in
//        main's log that the SW shim actually executed for each
//        extension.
//   V9 — wrap chrome.management.getSelf to return
//        installType: 'development'. Tampermonkey 5.4.x in MV3 gates
//        chrome.userScripts use on installType === 'development' (the
//        Chrome dev-mode toggle). Without this Tampermonkey decides
//        userScripts is unavailable and never even calls register().
//   V10 — single-promise getSelf wrapper (V9's two-callback path
//         called the user callback twice in callback-style mode,
//         which Tampermonkey's popup choked on → white screen).
//   V11 — chrome.proxy / chrome.privacy / chrome.browsingData stubs
//         so VPN / privacy extensions like Browsec don't crash on
//         first access (background.js:190 read 'settings' on
//         undefined chrome.proxy).
//   V12 — V11 stubs were silently failing on Browsec's chrome (likely
//         frozen for unknown-permission keys); switch direct
//         assignment to defineProperty-with-fallback so values land
//         on sealed objects too. Added stubs for chrome.contentSettings
//         / chrome.types / chrome.topSites / chrome.idle. Plus a
//         post-patch-state beacon to confirm in main's log that the
//         stubs actually took.
//   V13 — Stop the whack-a-mole. Wrap self.chrome in a Proxy that
//         returns a callable + chainable + event-like auto-stub for
//         ANY unknown property. Browsec was failing on a new line
//         (190 → 282 → 335) every iteration as we added stubs one
//         namespace at a time; the Proxy means there ARE no missing
//         namespaces from the SW's perspective. Specific patches
//         (chrome.userScripts, chrome.scripting.executeScript,
//         chrome.management.getSelf decoration) still land on the
//         real chrome and the Proxy preserves them via Reflect.get.
//   V14 — Real chrome.proxy.settings implementation: forwards the
//         extension's chrome.proxy.config to main, which converts to
//         Electron's session.setProxy() shape and applies to every
//         partitioned session. Browsec / Hola / Hoxx / similar VPN
//         extensions can now actually route traffic via Newbro.
//   V35 — chrome.runtime.onStartup actually fires on cold app start.
//         The library exposes runtime.onInstalled but not onStartup,
//         so until V35 listeners landed on a noop event stub. Browsec
//         gates proxy-state restoration on onStartup — without this,
//         the extension stays idle every cold launch until the user
//         clicks Turn on. Cold-start detection is a one-shot
//         /cold-start-check fetch against main: returns true exactly
//         once per (extId, main-process-lifetime).
//   V36 — diagnostic wrappers around chrome.runtime.onMessage and
//         chrome.runtime.onConnect. Logs each message / port the SW
//         actually receives so we can verify popup ↔ SW
//         communication. Browsec's popup-side toggle clicks update
//         state via runtime port; if the port message never reaches
//         the SW, the proxy stays in whatever state it was at boot.
//         No behaviour change — pure observability.
//   V37 — chrome.storage.onChanged cross-context bridge. In Electron
//         41 storage onChanged events fire only in the writing
//         context; popup writes to chrome.storage.local don't reach
//         the SW's listener, so Browsec's userPac state never re-
//         dispatches in the SW context, setActualPac never runs, and
//         the proxy stays on the previous country / smart-only state.
//         Bridges via a /storage-poll long-poll: popup-side preload
//         posts onChanged payloads to main, main queues per extId,
//         SW shim drains and dispatches to its bridged onChanged
//         listeners. Wraps chrome.storage so onChanged is OUR event
//         while local/sync/session pass through to the real storage.

export const SW_SHIM_MAGIC = '// __NEWBRO_SW_SHIM_V37__'
export const SW_SHIM_LEGACY_MAGIC = '// __NEWBRO_SW_SHIM_V1__'
export const SW_SHIM_FOOTER = '// __NEWBRO_SW_SHIM_END__'

export const SW_SHIM_HOST = 'newbro-ext-ipc.test'

/** Build the SW shim source with the loopback RPC server's port +
 *  secret baked in. The port comes from a loopback HTTP server we
 *  start at app boot (sw-rpc-server.ts); SWs can fetch
 *  http://127.0.0.1:<port> from secure contexts because Chromium
 *  considers loopback potentially-trustworthy. The secret gates access
 *  so anything else on the machine that finds the port can't
 *  impersonate the SW.
 *
 *  Both port + secret are PERSISTED across launches in
 *  userData/sw-rpc-config.json. injectSwShim only writes the file when
 *  the on-disk content actually differs from what we'd produce — so
 *  in steady state, every app boot is a no-op and Chromium's MV3
 *  service-worker byte-cache stays valid. Without persistence, the
 *  cached SW would wake up with a stale port baked in (the previous
 *  launch's), every auth-poll would hit ERR_CONNECTION_REFUSED, and
 *  VPN extensions like Browsec would need a "Fix connection" click
 *  on every restart before authenticating. */
export function buildSwShimSource(rpcPort: number, rpcSecret: string, partition: string): string {
  // JSON-quote the strings so they land safely as JS literals (no
  // injection from a partition name with quotes etc.).
  const portLit = String(rpcPort)
  const secretLit = JSON.stringify(rpcSecret)
  const partitionLit = JSON.stringify(partition)
  return SW_SHIM_TEMPLATE
    .replace(/__NEWBRO_RPC_PORT__/g, portLit)
    .replace(/"__NEWBRO_RPC_SECRET__"/g, secretLit)
    .replace(/"__NEWBRO_PARTITION__"/g, partitionLit)
}

const SW_SHIM_TEMPLATE = `${SW_SHIM_MAGIC}
// Polyfills chrome.userScripts + chrome.scripting.executeScript in MV3
// service-worker contexts. The rest of the chrome.* surface is provided
// by electron-chrome-extensions's own preload. Auto-injected by Newbro
// at install time. Safe to remove if you re-pack the extension.
;(function () {
  'use strict';
  var IPC_HOST = 'https://${SW_SHIM_HOST}';
  // Round-trip endpoint — fetched against a real loopback HTTP server
  // (sw-rpc-server.ts) that main starts at app boot. PORT and SECRET
  // are baked in at injection time via buildSwShimSource(). 127.0.0.1
  // is in Chromium's potentially-trustworthy allowlist for SW fetch,
  // so this transport works even when the extension's CSP is strict
  // (our patched CSP includes \`*\` in connect-src, which covers it).
  //
  // Failed alternatives: custom schemes (ERR_UNKNOWN_URL_SCHEME),
  // webRequest cancel (no body), webRequest redirect to data: URL
  // (ERR_UNSAFE_REDIRECT). The HTTP server is the only path that
  // delivers a real JSON response body to a SW fetch.
  var IPC_RPC = 'http://127.0.0.1:__NEWBRO_RPC_PORT__';
  var IPC_RPC_SECRET = "__NEWBRO_RPC_SECRET__";
  var IPC_RPC_PARTITION = "__NEWBRO_PARTITION__";
  function rpcHeaders(extra) {
    var h = {
      'X-Newbro-Token': IPC_RPC_SECRET,
      'X-Newbro-Partition': IPC_RPC_PARTITION,
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
      }
    }
    return h;
  }
  // Log a shim-internal failure. Routes through console.error (captured
  // by main via the SW console-message listener) AND sendPost so it
  // shows up in the structured log next to other shim events. NEVER use
  // an empty catch — the user explicitly banned that and there are real
  // bugs hiding behind it (e.g. fetch failures we couldn't see for
  // hours). 'pending' guard is for the recursive case (sendPost itself
  // failing): we log to console only, not back through sendPost.
  var swLogPending = false;
  function swLog(ctx, e) {
    var msg = '';
    try { msg = (e && (e.message || e.stack || String(e))) || ''; } catch (_) { msg = '(unstringifiable)'; }
    try { console.error('[newbro-sw-shim] ' + ctx + ': ' + msg); } catch (_) { /* console may be torn down — last-resort, nothing else to do */ }
    if (swLogPending) return;
    swLogPending = true;
    try {
      sendPost('sw-shim-error', { ctx: String(ctx).slice(0, 120), msg: String(msg).slice(0, 600) });
    } catch (inner) {
      try { console.error('[newbro-sw-shim] swLog/sendPost itself threw: ' + String(inner)); } catch (_) { /* nothing more we can do */ }
    } finally {
      swLogPending = false;
    }
  }
  function sendPost(action, body) {
    try {
      fetch(IPC_HOST + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(function (err) {
        // IPC_HOST is fire-and-forget by design — main intercepts via
        // webRequest.onBeforeRequest and calls callback({cancel:true}),
        // which manifests on the SW side as a "Failed to fetch"
        // rejection. That's the SUCCESS path for these one-way pings,
        // so we DON'T log it (the swallow is intentional and named).
        // A real "Failed to fetch" caused by something else (DNS, etc.)
        // can't happen here because the URL never reaches the network
        // — webRequest fires before resolution.
        var msg = (err && err.message) ? String(err.message) : String(err);
        if (msg.indexOf('Failed to fetch') !== -1) return;
        try { console.error('[newbro-sw-shim] sendPost(' + action + ') fetch rejected: ' + msg); }
        catch (_) { /* console torn down */ }
      });
    } catch (e) {
      try { console.error('[newbro-sw-shim] sendPost(' + action + ') threw: ' + String(e)); }
      catch (_) { /* console torn down */ }
    }
  }
  function getExtId(c) {
    try {
      return (c.runtime && c.runtime.id) ? String(c.runtime.id) : '';
    } catch (e) {
      swLog('getExtId', e);
      return '';
    }
  }

  // V27: catch every uncaught error in the SW context and forward to
  // main with full position info. Without this we only see Chromium's
  // truncated "Line: N Column: 1" dump, useless for the giant minified
  // webpack bundles VPN extensions ship. event.error.stack has the real
  // column number we need to find the offending call.
  try {
    self.addEventListener('error', function (event) {
      try {
        var c = self.chrome;
        var rid = (c && c.runtime && c.runtime.id) ? String(c.runtime.id) : '';
        sendPost('sw-error', {
          extId: rid,
          msg: String((event && event.message) || '').slice(0, 300),
          filename: String((event && event.filename) || '').slice(0, 200),
          lineno: event && event.lineno,
          colno: event && event.colno,
          stack: (event && event.error && event.error.stack)
            ? String(event.error.stack).slice(0, 2000)
            : '',
        });
      } catch (e) { swLog('sw-error-handler/sendPost', e); }
    });
  } catch (e) { swLog('sw-error-handler/addEventListener', e); }

  // ── V23 diagnostic instrumentation ─────────────────────────────
  // Goal: stop guessing which chrome.* API a VPN extension uses to
  // tunnel traffic. We record every unique top-level chrome.<ns>
  // property read (override / real / autostub), every fetch URL the
  // SW initiates and its outcome, and every WebSocket the SW opens.
  // After the user clicks Connect we can see the actual mechanism
  // (chrome.proxy, declarativeNetRequest, native messaging, raw
  // WebSocket tunnel, plain HTTPS API call, whatever it is) instead
  // of inferring it.
  var ACCESS_SEEN = Object.create(null);
  var ACCESS_QUEUE = [];
  var ACCESS_TIMER = null;
  var MISS_QUEUE = [];
  var MISS_TIMER = null;
  function trackChromeAccess(extId, prop, kind) {
    var key = extId + '|' + prop;
    if (ACCESS_SEEN[key]) return;
    ACCESS_SEEN[key] = 1;
    ACCESS_QUEUE.push({ extId: extId, prop: prop, kind: kind });
    if (!ACCESS_TIMER) {
      ACCESS_TIMER = setTimeout(function () {
        ACCESS_TIMER = null;
        var batch = ACCESS_QUEUE;
        ACCESS_QUEUE = [];
        try { sendPost('chrome-access', { items: batch }); }
        catch (e) { swLog('trackChromeAccess/flush', e); }
      }, 300);
    }
    // Emit autostub hits as a separate, higher-signal beacon so it's
    // trivially greppable in the log. Real Chrome features the extension
    // tried to use that we have NO implementation for surface here —
    // typical fix path is to add the namespace to NEWBRO_OVERRIDES or
    // patch it via the lib's preload.
    if (kind === 'autostub') {
      MISS_QUEUE.push({ extId: extId, prop: prop });
      if (!MISS_TIMER) {
        MISS_TIMER = setTimeout(function () {
          MISS_TIMER = null;
          var batch = MISS_QUEUE;
          MISS_QUEUE = [];
          try { sendPost('chrome-access-miss', { items: batch }); }
          catch (e) { swLog('trackChromeAccess/miss-flush', e); }
        }, 300);
      }
    }
  }
  function isOurIpcUrl(url) {
    return typeof url === 'string' && url.indexOf(IPC_HOST) === 0;
  }
  function installNetworkSpies(extId) {
    if (self.__newbroNetSpiesInstalled) return;
    self.__newbroNetSpiesInstalled = true;
    try {
      var rawFetch = self.fetch && self.fetch.bind(self);
      if (rawFetch) {
        self.fetch = function (input, init) {
          var url = '';
          try {
            url = (typeof input === 'string') ? input : (input && input.url) || String(input);
          } catch (e) { swLog('fetch-spy/url-extract', e); }
          var ours = isOurIpcUrl(url);
          var t0 = Date.now();
          if (!ours) {
            try {
              sendPost('fetch-start', {
                extId: extId,
                url: url.slice(0, 300),
                method: (init && init.method) || (input && input.method) || 'GET',
              });
            } catch (e) { swLog('fetch-spy/fetch-start', e); }
          }
          return rawFetch(input, init).then(function (resp) {
            if (!ours && (!resp.ok || resp.status >= 400)) {
              try {
                sendPost('fetch-end', {
                  extId: extId,
                  url: url.slice(0, 300),
                  status: resp.status,
                  ms: Date.now() - t0,
                });
              } catch (e) { swLog('fetch-spy/fetch-end', e); }
            }
            return resp;
          }, function (err) {
            if (!ours) {
              try {
                sendPost('fetch-error', {
                  extId: extId,
                  url: url.slice(0, 300),
                  err: String(err && err.message || err).slice(0, 200),
                  ms: Date.now() - t0,
                });
              } catch (e) { swLog('fetch-spy/fetch-error-report', e); }
            }
            throw err;
          });
        };
      }
    } catch (e) { swLog('fetch-spy/install', e); }
    try {
      var RealWS = self.WebSocket;
      if (RealWS) {
        var WrappedWS = new Proxy(RealWS, {
          construct: function (target, args) {
            try {
              sendPost('ws-open', {
                extId: extId,
                url: String(args[0]).slice(0, 300),
              });
            } catch (e) { swLog('ws-spy/ws-open', e); }
            return Reflect.construct(target, args);
          },
        });
        try { self.WebSocket = WrappedWS; }
        catch (e) { swLog('ws-spy/assign-WebSocket', e); }
      }
    } catch (e) { swLog('ws-spy/install', e); }
  }

  var REGISTERED = Object.create(null);
  // Hard-override map. Chromium intrinsics that we replace
  // (chrome.userScripts, chrome.scripting, chrome.proxy) sometimes
  // refuse to be redefined via Object.defineProperty — those
  // properties land in here so the wrapping Proxy at the end of this
  // shim can return our values regardless. See wrapChromeWithAutoStub.
  var NEWBRO_OVERRIDES = Object.create(null);

  function patch(c) {
    if (!c || typeof c !== 'object') return;

    var extId = getExtId(c);
    // Beacon BEFORE any of the per-namespace setup so we can see in
    // main's log whether patch() entered for each extension and what
    // chrome looks like before our overrides land.
    try {
      sendPost('patch-step', { extId: extId, step: 'enter', hasWebRequest: typeof c.webRequest !== 'undefined' });
    } catch (e) { swLog('patch/enter-beacon', e); }
    // Install fetch + WebSocket spies once per SW (V23). Done inside
    // patch so the extId is in scope for every logged event.
    try { installNetworkSpies(extId); } catch (e) { swLog('patch/installNetworkSpies', e); }

    // chrome.userScripts: register OUR namespace into NEWBRO_OVERRIDES
    // unconditionally. Chromium ships a partial chrome.userScripts in
    // the SW global whose methods are non-writable accessors that
    // resolve to undefined (the chrome://extensions Developer Mode
    // toggle is off; Electron exposes no UI for it). Both
    // Object.defineProperty and plain assignment can be silently
    // rejected by that intrinsic. The OVERRIDES map is consulted by
    // the wrapping Proxy at the bottom of this shim before
    // Reflect.get hits the real chrome, so our values reach the
    // extension regardless. We still attempt a direct write on the
    // chrome object as a belt-and-suspenders so any code that bypassed
    // the wrapper Proxy also sees our object.
    var us = {}
    NEWBRO_OVERRIDES['userScripts'] = us
    try {
      Object.defineProperty(c, 'userScripts', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: us,
      });
    } catch (e1) {
      swLog('patch/userScripts/defineProperty', e1);
      try { c.userScripts = us; }
      catch (e2) { swLog('patch/userScripts/assign-fallback', e2); }
    }
    us.register = function (scripts, cb) {
      var arr = Array.isArray(scripts) ? scripts : [scripts];
      arr.forEach(function (s) { if (s && s.id) REGISTERED[s.id] = s; });
      if (extId) sendPost('userscripts-register', { extId: extId, scripts: arr });
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    us.unregister = function (filter, cb) {
      var ids = (filter && Array.isArray(filter.ids)) ? filter.ids.slice() : null;
      if (ids) {
        ids.forEach(function (id) { delete REGISTERED[id]; });
      } else {
        REGISTERED = Object.create(null);
      }
      if (extId) sendPost('userscripts-unregister', { extId: extId, ids: ids });
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    us.update = function (scripts, cb) {
      var arr = Array.isArray(scripts) ? scripts : [scripts];
      arr.forEach(function (s) { if (s && s.id) REGISTERED[s.id] = s; });
      if (extId) sendPost('userscripts-update', { extId: extId, scripts: arr });
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    us.getScripts = function (filter, cb) {
      var ids = (filter && Array.isArray(filter.ids)) ? filter.ids : null;
      var out = [];
      for (var id in REGISTERED) {
        if (Object.prototype.hasOwnProperty.call(REGISTERED, id)) {
          if (!ids || ids.indexOf(id) !== -1) out.push(REGISTERED[id]);
        }
      }
      sendPost('userscripts-getScripts', { extId: extId, count: out.length });
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
      return Promise.resolve(out);
    };
    us.configureWorld = function (props, cb) {
      sendPost('userscripts-configureWorld', { extId: extId, props: props });
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    us.getWorldConfigurations = function (cb) {
      var out = [];
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
      return Promise.resolve(out);
    };
    us.resetWorldConfiguration = function (worldId, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    // Chrome 135+ chrome.userScripts.execute. Tampermonkey calls this
    // and chains .map on the result; without it the property reads as
    // undefined and the chain crashes.
    us.execute = function (injection, cb) {
      var results = [{ frameId: 0, documentId: '', result: undefined }];
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(results); });
      return Promise.resolve(results);
    };
    // chrome.userScripts.ExecutionWorld enum (Chrome MV3). TM reads
    // these constants to validate the world arg before register().
    us.ExecutionWorld = { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' };

    // chrome.webRequest.onAuthRequired: Browsec calls
    // chrome.webRequest.onAuthRequired.addListener at SW init to
    // handle 407 Proxy-Authentication-Required from its HTTPS
    // proxies. The library's preload only exposes
    // webRequest.onHeadersReceived, so .onAuthRequired is undefined
    // and Browsec crashes with "Cannot read properties of undefined
    // (reading 'addListener')". We add an event-shape stub and
    // forward registered listeners to main via newbro-ipc so the
    // session-level auth challenge actually reaches Browsec's
    // credentials callback.
    // chrome.webRequest.onAuthRequired stub.
    //
    // V18 added the listener via direct assignment to lib's
    // chrome.webRequest — silently failed because the lib freezes
    // that namespace. V19 replaced the namespace by COPYING props,
    // which broke popup controls (lost reference identity on
    // onHeadersReceived). V20's noop-via-direct-assignment didn't
    // help — same freeze.
    //
    // V21: wrap chrome.webRequest with a forwarding Proxy. The
    // Proxy intercepts only onAuthRequired and delegates every
    // other access to the live lib object via Reflect.get, so
    // onHeadersReceived and any internal lib state retain their
    // exact identity. The empty target Proxy pattern (proven by
    // V17 for chrome.userScripts / scripting / proxy) bypasses the
    // freeze entirely because the Proxy target is fresh.
    // V24: stub ALL standard webRequest events, not just onAuthRequired.
    // The library only exposes onHeadersReceived; every other event
    // (onBeforeRequest, onCompleted, onErrorOccurred, …) reads as
    // undefined, so an extension's xxx.addListener(...) crashes.
    // Browsec calls multiple webRequest event listeners at SW init —
    // the crash at bg.js line 719 was on the next addListener after
    // onAuthRequired, not onAuthRequired itself.
    var WEBREQUEST_EVENT_NAMES = [
      'onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders',
      'onHeadersReceived', 'onAuthRequired', 'onResponseStarted',
      'onBeforeRedirect', 'onCompleted', 'onErrorOccurred',
      'onActionIgnored',
    ];
    var wrEventStubs = Object.create(null);
    function makeWREventStub() {
      return {
        addListener: function () {},
        removeListener: function () {},
        hasListener: function () { return false; },
        hasListeners: function () { return false; },
      };
    }

    // chrome.webRequest.onAuthRequired — REAL implementation.
    //
    // VPN extensions (Browsec, Hola, etc.) call
    // chrome.webRequest.onAuthRequired.addListener(cb, filter,
    //   ['asyncBlocking']) at SW startup and expect to receive the
    // proxy 407 challenge so they can supply credentials. Stubbing it
    // out means main parks an auth challenge with no responder and
    // the connection wedges until our 15s timeout.
    //
    // Wiring: on first listener registration, start a long-poll loop
    // against newbro-ipc/auth-poll. When main has a parked challenge
    // for this partition, the response payload is { challenge: { id,
    // details } }. We dispatch to every listener; for asyncBlocking
    // mode we pass an asyncCallback as the 2nd arg and POST the
    // BlockingResponse the listener feeds it back on auth-respond.
    // For sync 'blocking' mode (less common), we use the listener's
    // return value directly. After dispatch, immediately re-poll so a
    // burst of challenges (Browsec's healthcheck pings multiple
    // webstat hosts) can each be answered without waiting for the
    // previous round-trip.
    var authListeners = [];
    var authPollActive = false;
    function dispatchAuthChallenge(challenge) {
      if (!challenge || typeof challenge.id !== 'string') return;
      var details = challenge.details || {};
      // Snapshot so a removeListener mid-dispatch doesn't desync.
      var snap = authListeners.slice();
      if (snap.length === 0) {
        // No listeners — let main's timeout fire so the connection
        // doesn't wedge. POST an empty response so main resolves now.
        sendAuthRespond(challenge.id, {});
        return;
      }
      // Track which listeners actually answered so we don't double-post.
      var answered = false;
      function answer(blockingResponse) {
        if (answered) return;
        answered = true;
        sendAuthRespond(challenge.id, blockingResponse || {});
      }
      // Safety net — if no listener calls asyncCallback within 10s,
      // give up so main's pending callback isn't held for the full
      // 15s timeout window. The extension's auth flow on a real
      // 407 is usually instant (creds stored in chrome.storage).
      var safety = setTimeout(function () {
        if (!answered) {
          swLog('onAuthRequired/safety-fallback', 'no listener answered within 10s; sending empty');
          answer({});
        }
      }, 10000);
      for (var i = 0; i < snap.length; i++) {
        var entry = snap[i];
        try {
          var asyncCallback = function (resp) {
            clearTimeout(safety);
            answer(resp);
          };
          var ret = entry.cb(details, asyncCallback);
          // sync 'blocking' mode: listener returned a BlockingResponse.
          if (ret && typeof ret === 'object' && (ret.authCredentials || ret.cancel)) {
            clearTimeout(safety);
            answer(ret);
            break;
          }
        } catch (e) {
          swLog('onAuthRequired/listener:' + i, e);
        }
      }
    }
    function sendAuthRespond(challengeId, blockingResponse) {
      try {
        fetch(IPC_RPC + '/auth-respond', {
          method: 'POST',
          headers: rpcHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ challengeId: challengeId, response: blockingResponse }),
        }).catch(function (err) {
          swLog('onAuthRequired/auth-respond-rejected', err);
        });
      } catch (e) {
        swLog('onAuthRequired/auth-respond-threw', e);
      }
    }
    function startAuthPoll() {
      if (authPollActive) return;
      authPollActive = true;
      function loop() {
        if (authListeners.length === 0) {
          authPollActive = false;
          return;
        }
        // Cache-busting nonce. Without this Chromium can serve a
        // cached response and we'd see the same challenge twice. extId
        // routes the challenge fan-out per extension — same challenge
        // hits every extension's SW that is concurrently polling, and
        // the first /auth-respond wins.
        var nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
        fetch(IPC_RPC + '/auth-poll?extId=' + encodeURIComponent(extId) + '&n=' + nonce, { method: 'GET', headers: rpcHeaders() })
          .then(function (r) { return r.json(); })
          .then(function (payload) {
            if (payload && payload.challenge) {
              dispatchAuthChallenge(payload.challenge);
            }
            // Poll again immediately. Main's 30s long-poll bounds the
            // idle case so we're not in a tight loop when nothing
            // happens.
            loop();
          }, function (err) {
            swLog('onAuthRequired/poll-rejected', err);
            // Backoff before retrying so a wedged main doesn't melt
            // the SW's event loop.
            setTimeout(loop, 2000);
          });
      }
      loop();
    }
    var onAuthRequiredEvent = {
      addListener: function (cb, filter, extraInfoSpec) {
        if (typeof cb !== 'function') return;
        authListeners.push({ cb: cb, filter: filter || null, extraInfoSpec: extraInfoSpec || null });
        sendPost('webRequest-onAuthRequired-add', {
          extId: extId,
          listenerCount: authListeners.length,
          extraInfoSpec: extraInfoSpec || null,
        });
        startAuthPoll();
      },
      removeListener: function (cb) {
        for (var i = authListeners.length - 1; i >= 0; i--) {
          if (authListeners[i].cb === cb) authListeners.splice(i, 1);
        }
      },
      hasListener: function (cb) {
        for (var i = 0; i < authListeners.length; i++) {
          if (authListeners[i].cb === cb) return true;
        }
        return false;
      },
      hasListeners: function () { return authListeners.length > 0; },
    };

    function getWREventStub(name) {
      if (name === 'onAuthRequired') return onAuthRequiredEvent;
      if (!wrEventStubs[name]) wrEventStubs[name] = makeWREventStub();
      return wrEventStubs[name];
    }
    var realWR = c.webRequest;
    var wrEmptyTarget = Object.create(null);
    var newWR = new Proxy(wrEmptyTarget, {
      get: function (_t, prop) {
        if (typeof prop === 'string' && WEBREQUEST_EVENT_NAMES.indexOf(prop) !== -1) {
          // onAuthRequired ALWAYS routes through our real implementation
          // (which forwards challenges from main back to extension
          // listeners). The library's chrome.webRequest.onAuthRequired,
          // if present, has no wiring to Electron's app.on('login') —
          // returning it would silently lose every challenge.
          if (prop === 'onAuthRequired') return onAuthRequiredEvent;
          if (realWR != null) {
            var rv = Reflect.get(realWR, prop);
            if (rv && typeof rv === 'object' && typeof rv.addListener === 'function') {
              return rv;
            }
          }
          return getWREventStub(prop);
        }
        if (realWR == null) return undefined;
        var v = Reflect.get(realWR, prop);
        if (typeof v === 'function') return v.bind(realWR);
        return v;
      },
      has: function (_t, prop) {
        if (typeof prop === 'string' && WEBREQUEST_EVENT_NAMES.indexOf(prop) !== -1) return true;
        return realWR != null ? Reflect.has(realWR, prop) : false;
      },
      set: function (_t, prop, value) {
        if (realWR != null) {
          try { return Reflect.set(realWR, prop, value); }
          catch (e) { swLog('webRequest-proxy/set:' + String(prop), e); }
        }
        return true;
      },
    });
    NEWBRO_OVERRIDES['webRequest'] = newWR;
    // Also fetch our own bg.js once so main can log the source around
    // the crash line — turns "Cannot read properties of undefined" at
    // line N into the actual code at line N. Cheap, fires once per SW.
    try {
      var ownUrl = (self.location && self.location.href) ? self.location.href : '';
      if (ownUrl && !self.__newbroSourceLogged) {
        self.__newbroSourceLogged = true;
        fetch(ownUrl).then(function (r) { return r.text(); }).then(function (text) {
          var allLines = text.split('\\n');
          var win = [];
          for (var i = 712; i <= 730 && i < allLines.length; i++) {
            win.push({ line: i + 1, text: String(allLines[i] || '').slice(0, 240) });
          }
          try {
            sendPost('bg-source-window', { extId: extId, totalLines: allLines.length, lines: win });
          } catch (e) { swLog('bg-source/sendPost', e); }
        }, function (err) { swLog('bg-source/fetch-text-rejected', err); });
      }
    } catch (e) { swLog('bg-source/setup', e); }
    try {
      sendPost('patch-step', {
        extId: extId,
        step: 'webRequest-override-set',
        realWRType: typeof realWR,
        overrideHasOnAuthRequired: typeof newWR.onAuthRequired,
      });
    } catch (e) { swLog('patch/wr-override-beacon', e); }

    // Synchronous diagnostic: log what we put on chrome.userScripts.
    // Fires before TM's init (which is on a microtask) so we always
    // get this lifeline even when TM crashes.
    try {
      sendPost('userscripts-shim-state', {
        extId: extId,
        methods: Object.keys(us),
        executionWorld: us.ExecutionWorld,
      });
    } catch (e) { swLog('patch/us-shim-state-beacon', e); }
    try {
      sendPost('patch-step', { extId: extId, step: 'after-userScripts-and-webRequest' });
    } catch (e) { swLog('patch/after-us-and-wr-beacon', e); }

    // ── chrome.management.getSelf ──────────────────────────────────
    // Tampermonkey 5.4.x checks chrome.management.getSelf().installType
    // and refuses to use chrome.userScripts unless it equals
    // 'development' (Chrome's dev-mode-on signal). Wrap getSelf so we
    // can overlay installType: 'development' on whatever Electron
    // returns. Single-promise path — V9's two-callback wrapper called
    // the user callback twice in the callback-style case which made
    // Tampermonkey's popup white-screen.
    var management = c.management || (c.management = {});
    var rawGetSelf = (typeof management.getSelf === 'function') ? management.getSelf.bind(management) : null;
    function decorateSelf(info) {
      info = info || {};
      info.installType = 'development';
      info.hostPermissions = info.hostPermissions && info.hostPermissions.length ? info.hostPermissions : ['<all_urls>'];
      info.enabled = true;
      info.mayDisable = true;
      info.id = info.id || extId;
      info.type = info.type || 'extension';
      return info;
    }
    function callRawGetSelf() {
      if (!rawGetSelf) return Promise.resolve(undefined);
      try {
        var maybe = rawGetSelf();
        if (maybe && typeof maybe.then === 'function') return maybe;
        return new Promise(function (resolve) {
          try { rawGetSelf(function (info) { resolve(info); }); }
          catch (e) {
            swLog('management.getSelf/callback-style', e);
            resolve(undefined);
          }
        });
      } catch (e) {
        swLog('management.getSelf/promise-style', e);
        return Promise.resolve(undefined);
      }
    }
    management.getSelf = function (cb) {
      var p = callRawGetSelf().then(decorateSelf, function (err) {
        swLog('management.getSelf/raw-rejected', err);
        return decorateSelf({});
      });
      if (typeof cb === 'function') p.then(function (info) {
        try { cb(info); }
        catch (e) { swLog('management.getSelf/user-cb', e); }
      });
      return p;
    };

    // ── chrome.runtime.onStartup — REAL implementation ─────────────
    // The library exposes onInstalled but NOT onStartup, so without
    // intervention chrome.runtime.onStartup.addListener(...) lands on
    // wrapNsWithEventFallback's noop event stub and the listener is
    // never called. Browsec gates ITS proxy-state restoration on
    // onStartup (look for the bg.js helper that resolves to either
    // onInstalled.addListener or onStartup.addListener depending on
    // manifest_version) — without a working onStartup the extension
    // sits idle every cold launch until the user clicks Turn on. Same
    // story for any other extension that uses onStartup to wake up.
    //
    // Semantics: real Chrome fires onStartup ONCE per cold browser
    // launch. We implement that by asking main /cold-start-check on
    // shim init: main returns true only the first time it's asked
    // for this extId in the current main-process lifetime. SW
    // restarts within the same app session (Chromium evicts idle SWs
    // after 30s) get false, matching real Chrome's behaviour.
    var coldStartListeners = [];
    var coldStartFired = null; // null = unknown, true = fire, false = don't
    function fireColdStartListener(cb) {
      if (typeof cb !== 'function') return;
      Promise.resolve().then(function () {
        try { cb(); }
        catch (e) { swLog('runtime.onStartup/cb', e); }
      });
    }
    var onStartupEvent = {
      addListener: function (cb) {
        if (typeof cb !== 'function') return;
        if (coldStartFired === true) {
          fireColdStartListener(cb);
          return;
        }
        coldStartListeners.push(cb);
      },
      removeListener: function (cb) {
        for (var i = coldStartListeners.length - 1; i >= 0; i--) {
          if (coldStartListeners[i] === cb) coldStartListeners.splice(i, 1);
        }
      },
      hasListener: function (cb) {
        for (var i = 0; i < coldStartListeners.length; i++) {
          if (coldStartListeners[i] === cb) return true;
        }
        return false;
      },
      hasListeners: function () { return coldStartListeners.length > 0; },
    };
    // Kick off the cold-start probe. The fetch goes to the loopback
    // RPC server with our shared secret, same channel as auth-poll.
    try {
      fetch(IPC_RPC + '/cold-start-check?extId=' + encodeURIComponent(extId), {
        method: 'GET',
        headers: rpcHeaders(),
      })
        .then(function (r) { return r.json(); })
        .then(function (payload) {
          var isCold = !!(payload && payload.isCold);
          coldStartFired = isCold;
          try {
            sendPost('runtime-onStartup-check', {
              extId: extId,
              isCold: isCold,
              listenerCount: coldStartListeners.length,
            });
          } catch (e) { swLog('runtime.onStartup/check-beacon', e); }
          if (isCold) {
            var snap = coldStartListeners.slice();
            coldStartListeners.length = 0;
            for (var i = 0; i < snap.length; i++) {
              fireColdStartListener(snap[i]);
            }
          }
        }, function (err) {
          swLog('runtime.onStartup/check-fetch-rejected', err);
          // Conservative fallback: don't fire. Worse to fire on a
          // SW restart than to skip a real cold start (extensions
          // typically also run init logic on the first message they
          // get from a popup / content script).
          coldStartFired = false;
        });
    } catch (e) { swLog('runtime.onStartup/check-fetch-threw', e); }
    // Wrap chrome.runtime so onStartup is OUR event but every other
    // property still resolves to the lib's runtime (getManifest,
    // sendMessage, onInstalled, onMessage, etc.). Empty-target Proxy
    // pattern same as our chrome.webRequest wrapper.
    var realRuntime = c.runtime;
    // Diagnostic wrappers around onMessage/onConnect/sendMessage/connect
    // so we can verify popup<->SW message flow in the log. Browsec's
    // popup talks to its SW via chrome.runtime.connect ports; if those
    // port messages don't reach the SW, popup-side toggle clicks have
    // no effect and the proxy stays in whatever state the SW restored
    // at cold start. Wrapping the LISTENER registrations lets us log
    // each message the SW actually receives without intercepting the
    // payload itself (we only log a short summary to keep the log
    // readable).
    function summarizeMsg(m) {
      try {
        if (m == null) return String(m);
        if (typeof m !== 'object') return typeof m + ':' + String(m).slice(0, 60);
        var s = JSON.stringify(m);
        if (s.length > 200) s = s.slice(0, 200) + '…';
        return s;
      } catch (e) { return '(unstringifiable: ' + String(e) + ')'; }
    }
    // Track every onMessage / onConnect listener registered through our
    // wrapper so the /runtime-msg-poll and /runtime-port-sw-poll bridges
    // can dispatch externally-originated messages and port-connects
    // (e.g. a chrome.userScripts-injected userscript that doesn't have
    // Chromium's chrome.* binding) to all of them. The native addListener
    // path still runs, so messages from real chrome.runtime.sendMessage
    // / connect callers (popup, options page) fire exactly once each as
    // before — only externally-bridged events need this separate dispatch
    // path.
    var onMessageListeners = [];
    var onConnectListeners = [];
    // portId → { onMessageListeners[], onDisconnectListeners[] }
    var bridgedPorts = Object.create(null);
    function wrapEventForLog(real, label) {
      if (!real || typeof real !== 'object' || typeof real.addListener !== 'function') return real;
      var origAdd = real.addListener.bind(real);
      var origRm = typeof real.removeListener === 'function' ? real.removeListener.bind(real) : null;
      var origHas = typeof real.hasListener === 'function' ? real.hasListener.bind(real) : null;
      var origHasL = typeof real.hasListeners === 'function' ? real.hasListeners.bind(real) : null;
      var wrapped = {
        addListener: function (cb) {
          if (typeof cb !== 'function') return origAdd(cb);
          if (label === 'onMessage') onMessageListeners.push(cb);
          if (label === 'onConnect') onConnectListeners.push(cb);
          var spy = function () {
            try {
              var args = Array.prototype.slice.call(arguments);
              var summary;
              if (label === 'onMessage') {
                summary = { msg: summarizeMsg(args[0]), senderId: args[1] && args[1].id, hasSendResponse: typeof args[2] === 'function' };
              } else if (label === 'onConnect') {
                summary = { portName: args[0] && args[0].name, senderId: args[0] && args[0].sender && args[0].sender.id };
              } else {
                summary = { args: args.length };
              }
              sendPost('runtime-event-' + label, { extId: extId, info: summary });
            } catch (e) { swLog('runtime-event-spy/' + label, e); }
            return cb.apply(this, arguments);
          };
          // Tag so removeListener can find the spy if extension uses
          // the original cb reference. We can't perfectly support that
          // because the spy is a different function; but for diagnostic
          // logging we accept that limitation.
          spy.__newbroOriginal = cb;
          return origAdd(spy);
        },
        removeListener: origRm ? function (cb) {
          if (label === 'onMessage') {
            var idx = onMessageListeners.indexOf(cb);
            if (idx !== -1) onMessageListeners.splice(idx, 1);
          }
          if (label === 'onConnect') {
            var ci = onConnectListeners.indexOf(cb);
            if (ci !== -1) onConnectListeners.splice(ci, 1);
          }
          // Best-effort: pass the cb through. Won't match our spy, but
          // most extensions never removeListener anyway.
          return origRm(cb);
        } : undefined,
        hasListener: origHas ? function (cb) { return origHas(cb); } : undefined,
        hasListeners: origHasL ? function () { return origHasL(); } : undefined,
      };
      return wrapped;
    }

    // Long-poll loop for bridged runtime.sendMessage. Starts after the
    // SW has registered its first onMessage listener. Each message
    // received from main has an msgId; we collect the response from
    // listeners and POST it back. Async-response semantics via
    // sendResponse: listeners that return true keep the channel open
    // and call sendResponse later; we wait up to 5s for that.
    var runtimeMsgPollActive = false;
    function dispatchBridgedRuntimeMessage(msg) {
      var msgId = msg.msgId;
      var payload = msg.payload;
      var snap = onMessageListeners.slice();
      var settled = false;
      var responded = false;
      function respond(value) {
        if (settled) return;
        settled = true;
        try {
          fetch(IPC_RPC + '/runtime-msg-respond', {
            method: 'POST',
            headers: rpcHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ msgId: msgId, response: value }),
          }).catch(function (err) { swLog('bridged-msg/respond-fetch', err); });
        } catch (e) { swLog('bridged-msg/respond-throw', e); }
      }
      var sender = { id: extId, origin: 'newbro-bridge', frameId: 0, tab: undefined };
      var anyAsync = false;
      for (var i = 0; i < snap.length; i++) {
        try {
          var r = snap[i](payload, sender, function (val) {
            if (!responded) { responded = true; respond(val); }
          });
          if (r === true) anyAsync = true;
        } catch (e) { swLog('bridged-msg/listener:' + i, e); }
      }
      if (!anyAsync) {
        // Synchronous dispatch — if nobody called sendResponse, reply
        // with empty so the userscript-world Promise resolves.
        if (!responded) { responded = true; respond({}); }
      } else {
        // Async path: wait up to 5s for sendResponse. After that, reply
        // with empty so the requestor doesn't hang forever.
        setTimeout(function () {
          if (!responded) { responded = true; respond({}); }
        }, 5000);
      }
    }
    function startRuntimeMsgPoll() {
      if (runtimeMsgPollActive) return;
      runtimeMsgPollActive = true;
      function loop() {
        var nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
        fetch(IPC_RPC + '/runtime-msg-poll?extId=' + encodeURIComponent(extId) + '&n=' + nonce, {
          method: 'GET',
          headers: rpcHeaders(),
        })
          .then(function (r) { return r.json(); })
          .then(function (payload) {
            if (payload && payload.message) {
              try { dispatchBridgedRuntimeMessage(payload.message); }
              catch (e) { swLog('runtimeMsgPoll/dispatch', e); }
            }
            loop();
          }, function (err) {
            swLog('runtimeMsgPoll/rejected', err);
            setTimeout(loop, 2000);
          });
      }
      loop();
    }
    // Kick off the poll loop right after the wrappers are set up; the
    // listener list will fill in as Browsec/TM call onMessage.addListener.
    try { startRuntimeMsgPoll(); }
    catch (e) { swLog('startRuntimeMsgPoll', e); }

    // ── chrome.runtime.connect port bridge (SW side) ───────────────
    // For each port a non-binding context (typically a TM-style
    // chrome.userScripts-injected content script) opens, we build a
    // fake Port object here and call every chrome.runtime.onConnect
    // listener with it. postMessage on the fake port POSTs to main;
    // main delivers to the userscript's content-poll. messages from
    // the userscript come back via our /runtime-port-sw-poll loop
    // and we dispatch them to the fake port's onMessage listeners.
    function buildBridgedPort(portId, name) {
      var portState = { onMessageListeners: [], onDisconnectListeners: [], disconnected: false };
      bridgedPorts[portId] = portState;
      var port = {
        name: name || '',
        sender: { id: extId, frameId: 0, origin: 'newbro-bridge' },
        postMessage: function (msg) {
          if (portState.disconnected) return;
          try {
            fetch(IPC_RPC + '/runtime-port-sw-send', {
              method: 'POST',
              headers: rpcHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ portId: portId, message: msg }),
            }).catch(function (err) { swLog('port/sw-send-fetch:' + portId, err); });
          } catch (e) { swLog('port/sw-send-throw:' + portId, e); }
        },
        disconnect: function () {
          if (portState.disconnected) return;
          portState.disconnected = true;
          delete bridgedPorts[portId];
          try {
            fetch(IPC_RPC + '/runtime-port-disconnect', {
              method: 'POST',
              headers: rpcHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ portId: portId, side: 'sw' }),
            }).catch(function (err) { swLog('port/sw-disconnect-fetch:' + portId, err); });
          } catch (e) { swLog('port/sw-disconnect-throw:' + portId, e); }
        },
        onMessage: {
          addListener: function (cb) { if (typeof cb === 'function') portState.onMessageListeners.push(cb); },
          removeListener: function (cb) {
            var i = portState.onMessageListeners.indexOf(cb);
            if (i !== -1) portState.onMessageListeners.splice(i, 1);
          },
          hasListener: function (cb) { return portState.onMessageListeners.indexOf(cb) !== -1; },
          hasListeners: function () { return portState.onMessageListeners.length > 0; },
        },
        onDisconnect: {
          addListener: function (cb) { if (typeof cb === 'function') portState.onDisconnectListeners.push(cb); },
          removeListener: function (cb) {
            var i = portState.onDisconnectListeners.indexOf(cb);
            if (i !== -1) portState.onDisconnectListeners.splice(i, 1);
          },
          hasListener: function (cb) { return portState.onDisconnectListeners.indexOf(cb) !== -1; },
          hasListeners: function () { return portState.onDisconnectListeners.length > 0; },
        },
      };
      portState.port = port;
      return port;
    }
    function dispatchPortConnect(portId, name) {
      var port = buildBridgedPort(portId, name);
      var snap = onConnectListeners.slice();
      for (var i = 0; i < snap.length; i++) {
        try { snap[i](port); }
        catch (e) { swLog('port/onConnect-listener:' + i, e); }
      }
    }
    function dispatchPortMessage(portId, message) {
      var s = bridgedPorts[portId];
      if (!s) return;
      var snap = s.onMessageListeners.slice();
      for (var i = 0; i < snap.length; i++) {
        try { snap[i](message, s.port); }
        catch (e) { swLog('port/onMessage-listener:' + i, e); }
      }
    }
    function dispatchPortDisconnect(portId) {
      var s = bridgedPorts[portId];
      if (!s) return;
      s.disconnected = true;
      delete bridgedPorts[portId];
      var snap = s.onDisconnectListeners.slice();
      for (var i = 0; i < snap.length; i++) {
        try { snap[i](s.port); }
        catch (e) { swLog('port/onDisconnect-listener:' + i, e); }
      }
    }
    var portPollActive = false;
    function startPortSwPoll() {
      if (portPollActive) return;
      portPollActive = true;
      function loop() {
        var nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
        fetch(IPC_RPC + '/runtime-port-sw-poll?extId=' + encodeURIComponent(extId) + '&n=' + nonce, {
          method: 'GET',
          headers: rpcHeaders(),
        })
          .then(function (r) { return r.json(); })
          .then(function (payload) {
            if (payload && payload.event) {
              var ev = payload.event;
              try {
                if (ev.type === 'connect') dispatchPortConnect(ev.portId, ev.name);
                else if (ev.type === 'msg') dispatchPortMessage(ev.portId, ev.message);
                else if (ev.type === 'disconnect') dispatchPortDisconnect(ev.portId);
              } catch (e) { swLog('port/dispatch', e); }
            }
            loop();
          }, function (err) {
            swLog('portSwPoll/rejected', err);
            setTimeout(loop, 2000);
          });
      }
      loop();
    }
    try { startPortSwPoll(); }
    catch (e) { swLog('startPortSwPoll', e); }
    var wrappedOnMessage = null;
    var wrappedOnConnect = null;
    var runtimeProxy = new Proxy(Object.create(null), {
      get: function (_t, prop) {
        if (prop === 'onStartup') return onStartupEvent;
        if (realRuntime == null) return undefined;
        if (prop === 'onMessage') {
          if (!wrappedOnMessage) wrappedOnMessage = wrapEventForLog(realRuntime.onMessage, 'onMessage');
          return wrappedOnMessage;
        }
        if (prop === 'onConnect') {
          if (!wrappedOnConnect) wrappedOnConnect = wrapEventForLog(realRuntime.onConnect, 'onConnect');
          return wrappedOnConnect;
        }
        var v = Reflect.get(realRuntime, prop);
        if (typeof v === 'function') return v.bind(realRuntime);
        return v;
      },
      has: function (_t, prop) {
        if (prop === 'onStartup') return true;
        return realRuntime != null ? Reflect.has(realRuntime, prop) : false;
      },
      set: function (_t, prop, value) {
        if (realRuntime != null) {
          try { return Reflect.set(realRuntime, prop, value); }
          catch (e) { swLog('runtime-proxy/set:' + String(prop), e); }
        }
        return true;
      },
    });
    NEWBRO_OVERRIDES['runtime'] = runtimeProxy;

    // ── chrome.storage.onChanged bridge ────────────────────────────
    // In Electron 41, chrome.storage.onChanged fires in the writing
    // context only. When Browsec's popup writes userPac to
    // chrome.storage.local (e.g. country picker → mode=proxy,
    // country=hr), the popup's storageListener fires and updates the
    // popup's local store, but the SW's identical listener never
    // fires. As a result, the SW's setActualPac (gated on User PAC
    // changes) never runs, and the proxy stays on the previous
    // country (or stays in the smart-only state with
    // globalReturn=null). Visible symptom: clicking a country in
    // the popup looks like it took, but the actual IP doesn't change.
    //
    // Fix: bridge through main. The popup-side preload posts each
    // chrome.storage.onChanged payload to main via newbro-ipc; main
    // queues per extId; SW long-polls /storage-poll and dispatches
    // received changes to the SW's own onChanged listeners. We wrap
    // chrome.storage.onChanged.addListener so we can keep an
    // independent listener list to call (the underlying native event
    // would still receive the listener, but firing it cross-context
    // is what doesn't work — so our list is what makes it actually
    // dispatch).
    var storageOnChangedListeners = [];
    var storagePollActive = false;
    function fireStorageChange(changes, areaName) {
      if (!changes || typeof changes !== 'object') return;
      var snap = storageOnChangedListeners.slice();
      for (var i = 0; i < snap.length; i++) {
        try { snap[i](changes, areaName || 'local'); }
        catch (e) { swLog('storage.onChanged/listener:' + i, e); }
      }
    }
    function startStoragePoll() {
      if (storagePollActive) return;
      storagePollActive = true;
      function loop() {
        if (storageOnChangedListeners.length === 0) {
          storagePollActive = false;
          return;
        }
        var nonce = Date.now() + '-' + Math.random().toString(36).slice(2);
        fetch(IPC_RPC + '/storage-poll?extId=' + encodeURIComponent(extId) + '&n=' + nonce, {
          method: 'GET',
          headers: rpcHeaders(),
        })
          .then(function (r) { return r.json(); })
          .then(function (payload) {
            if (payload && payload.change) {
              try {
                sendPost('storage-bridge-recv', {
                  extId: extId,
                  areaName: payload.change.areaName,
                  keys: Object.keys(payload.change.changes || {}),
                });
              } catch (e) { swLog('storage.poll/recv-beacon', e); }
              fireStorageChange(payload.change.changes, payload.change.areaName);
            }
            loop();
          }, function (err) {
            swLog('storage.poll/rejected', err);
            // Backoff so a wedged main doesn't melt the SW's event loop.
            setTimeout(loop, 2000);
          });
      }
      loop();
    }
    var realStorage = c.storage;
    if (realStorage && realStorage.onChanged && typeof realStorage.onChanged.addListener === 'function') {
      var realStorageOnChanged = realStorage.onChanged;
      var origAddOnChanged = realStorageOnChanged.addListener.bind(realStorageOnChanged);
      var origRmOnChanged = typeof realStorageOnChanged.removeListener === 'function'
        ? realStorageOnChanged.removeListener.bind(realStorageOnChanged) : null;
      var bridgedOnChanged = {
        addListener: function (cb) {
          if (typeof cb !== 'function') return;
          storageOnChangedListeners.push(cb);
          // Also register with native — harmless if it never fires
          // for cross-context writes; works for SAME-context writes
          // (e.g. SW's own chrome.storage.local.set should still get
          // a native event in the SW).
          try { origAddOnChanged(cb); }
          catch (e) { swLog('storage.onChanged/native-add', e); }
          startStoragePoll();
        },
        removeListener: function (cb) {
          var i = storageOnChangedListeners.indexOf(cb);
          if (i !== -1) storageOnChangedListeners.splice(i, 1);
          if (origRmOnChanged) {
            try { origRmOnChanged(cb); }
            catch (e) { swLog('storage.onChanged/native-remove', e); }
          }
        },
        hasListener: function (cb) {
          return storageOnChangedListeners.indexOf(cb) !== -1;
        },
        hasListeners: function () {
          return storageOnChangedListeners.length > 0;
        },
      };
      // Wrap chrome.storage with a Proxy that returns OUR onChanged
      // but lets every other property (local, sync, session, etc.)
      // pass through to the real storage namespace.
      var storageProxy = new Proxy(Object.create(null), {
        get: function (_t, prop) {
          if (prop === 'onChanged') return bridgedOnChanged;
          var v = Reflect.get(realStorage, prop);
          if (typeof v === 'function') return v.bind(realStorage);
          return v;
        },
        has: function (_t, prop) {
          if (prop === 'onChanged') return true;
          return Reflect.has(realStorage, prop);
        },
        set: function (_t, prop, value) {
          try { return Reflect.set(realStorage, prop, value); }
          catch (e) { swLog('storage-proxy/set:' + String(prop), e); return true; }
        },
      });
      NEWBRO_OVERRIDES['storage'] = storageProxy;
    } else {
      sendPost('storage-onChanged-missing', { extId: extId, hasStorage: typeof realStorage });
    }

    // ── chrome.proxy.settings — REAL implementation ────────────────
    // VPN extensions (Browsec, Hola, etc.) call
    // chrome.proxy.settings.set({ value: { mode, rules: { singleProxy
    // }, … } }) to install a proxy. Our auto-stub for unknown
    // chrome.* surfaces (set up later in this IIFE) would no-op the
    // call, so the proxy never landed and the user's IP never
    // changed. Wire the call to main: forward { mode, rules } in
    // chrome.proxy.config shape, main converts it to Electron's
    // proxyRules string and calls ses.setProxy() on every partition.
    var proxySettings = {
      set: function (details, cb) {
        try {
          var value = (details && details.value) ? details.value : null;
          if (value) {
            sendPost('proxy-settings-set', {
              extId: extId,
              scope: details && details.scope,
              value: value,
            });
          }
        } catch (e) { swLog('proxy.settings.set/sendPost', e); }
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      get: function (_d, cb) {
        // We don't currently round-trip the live proxy config back —
        // return system-mode so Browsec sees a known-baseline state.
        var out = {
          value: { mode: 'system' },
          levelOfControl: 'controllable_by_this_extension',
          incognitoSpecific: false,
        };
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
        return Promise.resolve(out);
      },
      clear: function (_d, cb) {
        sendPost('proxy-settings-clear', { extId: extId });
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      onChange: {
        addListener: function () {},
        removeListener: function () {},
        hasListener: function () { return false; },
      },
    };
    // Register chrome.proxy into NEWBRO_OVERRIDES so the wrapping
    // Proxy returns OUR object regardless of whether the underlying
    // assignment lands. Chromium intrinsics for chrome.proxy can be
    // non-writable accessors in the same way chrome.userScripts and
    // chrome.scripting are.
    // chrome.proxy.onError fires when the PAC script raises an error or
    // a proxy connection fails. Browsec calls
    // chrome.proxy.onError.addListener(...) at SW init to relay errors
    // into its UI; without a stub here our SW dies on
    // undefined.addListener. onProxyError is the standard MV3 alias —
    // alias it to the same stub.
    var proxyOnErrorListeners = []
    var proxyErrorEvent = {
      addListener: function (cb) { if (typeof cb === 'function') proxyOnErrorListeners.push(cb); },
      removeListener: function (cb) {
        var i = proxyOnErrorListeners.indexOf(cb);
        if (i !== -1) proxyOnErrorListeners.splice(i, 1);
      },
      hasListener: function (cb) { return proxyOnErrorListeners.indexOf(cb) !== -1; },
    };
    var proxyNamespace = {
      settings: proxySettings,
      onError: proxyErrorEvent,
      onProxyError: proxyErrorEvent,
    }
    NEWBRO_OVERRIDES['proxy'] = proxyNamespace
    try { c.proxy = proxyNamespace; }
    catch (e1) {
      swLog('patch/proxy/assign', e1);
      try {
        Object.defineProperty(c, 'proxy', {
          configurable: true, enumerable: true, writable: true,
          value: proxyNamespace,
        });
      } catch (e2) {
        // OVERRIDES map will still satisfy chrome.proxy reads via the
        // wrapping Proxy at the bottom of the IIFE — log so we can see
        // when this falls back, but it's expected on Chromium intrinsics
        // pinned as non-configurable.
        swLog('patch/proxy/defineProperty-fallback', e2);
      }
    }

    function chromeSettingStub(defaultValue) {
      var listeners = [];
      return {
        get: function (_details, cb) {
          var out = { value: defaultValue, levelOfControl: 'controllable_by_this_extension', incognitoSpecific: false };
          if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
          return Promise.resolve(out);
        },
        set: function (_details, cb) {
          if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
          return Promise.resolve();
        },
        clear: function (_details, cb) {
          if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
          return Promise.resolve();
        },
        onChange: {
          addListener: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
          removeListener: function (fn) {
            var i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
          },
          hasListener: function (fn) { return listeners.indexOf(fn) !== -1; },
        },
      };
    }
    var noopEvent = {
      addListener: function () {},
      removeListener: function () {},
      hasListener: function () { return false; },
    };

    // ── chrome.cookies ────────────────────────────────────────────────
    // The library implements chrome.cookies for FRAME contexts via its
    // preload IPC, but that preload doesn't fire in SW context (Electron
    // 41 quirk). An extension calling chrome.cookies.get/set/etc. from
    // its service worker would otherwise hit our auto-stub and silently
    // no-op. Forward via the loopback RPC server, which dispatches to
    // session.cookies on the focused window's partition. Multi-profile
    // routing is approximate — see pickCookiesSession in main.
    function cookiesRpc(op, details) {
      var method = (op === 'get' || op === 'getAll') ? 'GET' : 'POST';
      var url = IPC_RPC + '/cookies/' + op;
      var opts = { method: method, headers: rpcHeaders() };
      if (method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(details || {});
      } else if (details && typeof details === 'object') {
        var qs = [];
        for (var k in details) {
          if (Object.prototype.hasOwnProperty.call(details, k) && details[k] !== undefined) {
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(details[k])));
          }
        }
        if (qs.length) url += '?' + qs.join('&');
      }
      return fetch(url, opts)
        .then(function (r) { return r.json(); })
        .then(function (j) { return j && j.result; });
    }
    function cookiesShim(op, fallback) {
      return function (details, cb) {
        var p = cookiesRpc(op, details || {}).then(
          function (r) { return r === undefined ? fallback : r; },
          function (err) { swLog('cookies.' + op, err); return fallback; }
        );
        if (typeof cb === 'function') {
          p.then(function (v) { try { cb(v); } catch (e) { swLog('cookies.' + op + '/cb', e); } });
        }
        return p;
      };
    }
    var cookiesNamespace = {
      get: cookiesShim('get', null),
      getAll: cookiesShim('getAll', []),
      set: cookiesShim('set', null),
      remove: cookiesShim('remove', null),
      getAllCookieStores: function (cb) {
        var stores = [{ id: '0', tabIds: [] }];
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(stores); });
        return Promise.resolve(stores);
      },
      onChanged: noopEvent,
    };
    NEWBRO_OVERRIDES['cookies'] = cookiesNamespace;
    try {
      Object.defineProperty(c, 'cookies', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cookiesNamespace,
      });
    } catch (e1) {
      try { c.cookies = cookiesNamespace; }
      catch (e2) {
        // Chromium intrinsic is non-configurable AND non-writable —
        // our override only lands via the wrapping Proxy, which kicks
        // in if wrap-chrome-diag.finalChromeIsWrapped is true. Same
        // expected fallback as chrome.proxy / userScripts; log only
        // once at info so this doesn't show up as a recurring sw-shim
        // error on every fresh SW.
        sendPost('patch-step', { extId: extId, step: 'cookies-pin-fallback', e1: String(e1).slice(0, 160), e2: String(e2).slice(0, 160) });
      }
    }

    // Whack-a-mole stubs (V11 chrome.proxy, V12 chrome.contentSettings
    // / chrome.types / chrome.topSites / chrome.idle) kept inching
    // forward Browsec's crash one line at a time — fix line 190,
    // crash at 282, fix that, crash at 335. The real fix: wrap
    // self.chrome in a Proxy that auto-stubs ANY unknown property
    // with a chainable + callable + event-like stub. Anything that
    // returns undefined on a real chrome.X access now returns an
    // auto-stub instead, so chrome.WHATEVER.foo.bar.baz(callback)
    // resolves with a Promise, fires the callback, and chains
    // forever. The SW can't crash on a missing chrome.* surface
    // because there are no missing surfaces from its perspective.
    //
    // Done LATER in the patch, after the specific namespace patches
    // (chrome.userScripts, chrome.scripting.executeScript,
    // chrome.management.getSelf) so the Proxy preserves their real
    // shape via Reflect.get.

    // chrome.scripting: register into NEWBRO_OVERRIDES same as
    // chrome.userScripts above. Chromium's intrinsic chrome.scripting
    // has the same non-writable-method problem.
    var scripting = {}
    NEWBRO_OVERRIDES['scripting'] = scripting
    try {
      Object.defineProperty(c, 'scripting', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: scripting,
      });
    } catch (e1) {
      swLog('patch/scripting/defineProperty', e1);
      try { c.scripting = scripting; }
      catch (e2) { swLog('patch/scripting/assign-fallback', e2); }
    }
    scripting.executeScript = function (injection, cb) {
      try {
        var body = '';
        var fn = injection && injection.func;
        if (typeof fn === 'function') body = '(' + fn.toString() + ').apply(null, ' + JSON.stringify(injection.args || []) + ');';
        else if (Array.isArray(injection && injection.files)) body = '/* file injection not yet supported */';
        else if (typeof (injection && injection.code) === 'string') body = injection.code;
        var tabIds = (injection && injection.target && Array.isArray(injection.target.tabIds)) ? injection.target.tabIds : [];
        sendPost('scripting-execute', {
          extId: extId,
          tabIds: tabIds,
          allFrames: injection && injection.target && injection.target.allFrames === true,
          world: (injection && injection.world) || 'ISOLATED',
          body: body,
        });
      } catch (e) { swLog('scripting.executeScript/sendPost', e); }
      var results = [{ frameId: 0, result: undefined }];
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(results); });
      return Promise.resolve(results);
    };
    // Methods Tampermonkey + others probe at init time. Each must
    // resolve with [] so an awaited .map of the result does not crash.
    scripting.getRegisteredContentScripts = function (filter, cb) {
      var out = [];
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
      return Promise.resolve(out);
    };
    scripting.registerContentScripts = function (scripts, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    scripting.unregisterContentScripts = function (filter, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    scripting.updateContentScripts = function (scripts, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    scripting.insertCSS = function (injection, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };
    scripting.removeCSS = function (injection, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
      return Promise.resolve();
    };

    // chrome.tabs.create fallback. Normally chrome.tabs comes from
    // electron-chrome-extensions's session preload, but when the SW
    // crashes (e.g. Browsec's importScripts('/lodash.js') hit a
    // transient error) Chromium restarts the SW and the library's
    // preload doesn't always re-fire, leaving us with a chrome.tabs
    // that lacks .create. Browsec's "Diagnostics" / healthcheck button
    // calls chrome.tabs.create on click; without this it no-ops
    // silently and the healthcheck never runs. We patch in place: if
    // .create is already a function (library preload did fire) we
    // leave it alone, so this is a no-op in the happy path.
    try {
      var tabs = c.tabs;
      var hasCreate = !!(tabs && typeof tabs === 'object' && typeof tabs.create === 'function');
      if (!hasCreate) {
        if (!tabs || typeof tabs !== 'object') {
          tabs = {};
          try {
            Object.defineProperty(c, 'tabs', {
              configurable: true,
              enumerable: true,
              writable: true,
              value: tabs,
            });
          } catch (e1) {
            swLog('patch/tabs/defineProperty', e1);
            try { c.tabs = tabs; }
            catch (e2) { swLog('patch/tabs/assign-fallback', e2); }
          }
        }
        try {
          tabs.create = function (details, cb) {
            var url = (details && details.url) ? String(details.url) : 'about:blank';
            try {
              fetch(IPC_HOST + '/open-tab?url=' + encodeURIComponent(url))
                .catch(function (err) { swLog('tabs.create/ipc-fetch-rejected', err); });
            } catch (e) { swLog('tabs.create/ipc-fetch-threw', e); }
            var fakeTab = {
              id: 0,
              url: url,
              active: details ? details.active !== false : true,
            };
            if (typeof cb === 'function') {
              Promise.resolve().then(function () {
                try { cb(fakeTab); }
                catch (e) { swLog('tabs.create/user-cb', e); }
              });
            }
            return Promise.resolve(fakeTab);
          };
        } catch (e) { swLog('tabs.create/install', e); }
      }
    } catch (e) { swLog('patch/tabs-fallback', e); }
  }
  // Tell main this shim actually ran in this extension's SW context
  // BEFORE we patch — confirms the prepended source executes for
  // each extension instead of being silently overridden somehow.
  try {
    var initialExtId = (self.chrome && self.chrome.runtime && self.chrome.runtime.id) ? String(self.chrome.runtime.id) : '';
    sendPost('sw-shim-ran', {
      extId: initialExtId,
      hasChrome: typeof self.chrome !== 'undefined',
      hasUserScripts: typeof (self.chrome && self.chrome.userScripts) !== 'undefined',
      hasUserScriptsRegister: !!(self.chrome && self.chrome.userScripts && typeof self.chrome.userScripts.register === 'function'),
      hasScripting: typeof (self.chrome && self.chrome.scripting) !== 'undefined',
      hasScriptingExecuteScript: !!(self.chrome && self.chrome.scripting && typeof self.chrome.scripting.executeScript === 'function'),
    });
  } catch (e) { swLog('sw-shim-ran-beacon', e); }
  // ── Auto-stub Proxy ─────────────────────────────────────────────
  // For ANY chrome.* namespace not provided by Electron / library /
  // our specific patches, return a chainable + callable + event-like
  // stub. Means chrome.proxy.settings.set(details, cb) resolves
  // safely instead of throwing 'Cannot read settings on undefined'.
  // Browsec / VPN / privacy extensions touch lots of these and
  // crashing on the first missing one made the SW DOA.
  //
  // The auto-stub is itself a Proxy on a function so:
  //   - typeof X === 'function'
  //   - X(...) returns Promise.resolve() and fires the last-arg
  //     callback (chrome async API contract)
  //   - X.foo / X[0] / X.bar.baz returns another auto-stub (chainable)
  //   - X.addListener / .removeListener are no-ops
  //   - X.hasListener returns false
  // V27: wrap any chrome.<ns> object so a missing event-shaped property
  // (anything matching /^on[A-Z]/) returns a no-op event stub instead of
  // undefined. The lib's tabs factory exposes only onCreated/onRemoved/
  // onUpdated/onActivated/onReplaced — missing onZoomChange/onAttached/
  // onDetached/onMoved. Same gap on runtime/windows/etc. when the lib's
  // SW preload doesn't fire (Electron 41 quirk). Browsec's webpack
  // bundle calls some missing on<Event>.addListener and the SW dies on
  // undefined.addListener. This makes EVERY namespace forgiving.
  // Cache the wrapper per real object so chrome.runtime === chrome.runtime
  // identity holds across reads.
  var nsWrapCache = new WeakMap();
  function wrapNsWithEventFallback(real) {
    if (!real || typeof real !== 'object') return real;
    if (nsWrapCache.has(real)) return nsWrapCache.get(real);
    var stubCache = Object.create(null);
    var p = new Proxy(Object.create(null), {
      get: function (_t, prop) {
        var v;
        try { v = Reflect.get(real, prop); }
        catch (e) { swLog('nsWrap/get:' + String(prop), e); v = undefined; }
        if (v !== undefined && v !== null) {
          if (typeof v === 'function') return v.bind(real);
          return v;
        }
        if (typeof prop === 'string' && /^on[A-Z]/.test(prop)) {
          if (!stubCache[prop]) {
            stubCache[prop] = {
              addListener: function () {},
              removeListener: function () {},
              hasListener: function () { return false; },
              hasListeners: function () { return false; },
            };
          }
          return stubCache[prop];
        }
        return undefined;
      },
      has: function (_t, prop) {
        if (typeof prop === 'string' && /^on[A-Z]/.test(prop)) return true;
        try { return Reflect.has(real, prop); }
        catch (e) { swLog('nsWrap/has:' + String(prop), e); return false; }
      },
      set: function (_t, prop, value) {
        try { return Reflect.set(real, prop, value); }
        catch (e) { swLog('nsWrap/set:' + String(prop), e); return true; }
      },
    });
    nsWrapCache.set(real, p);
    return p;
  }

  function makeAutoStub() {
    var fn = function autoStub() {
      var cb = arguments.length > 0 ? arguments[arguments.length - 1] : undefined;
      if (typeof cb === 'function') {
        Promise.resolve().then(function () {
          try { cb(); }
          catch (e) { swLog('autoStub/user-cb', e); }
        });
      }
      return Promise.resolve();
    };
    return new Proxy(fn, {
      get: function (target, prop) {
        if (prop === Symbol.toPrimitive) return function () { return ''; };
        if (prop === 'toString') return function () { return '[autoStub]'; };
        if (prop === 'valueOf') return function () { return undefined; };
        if (prop === Symbol.iterator) return undefined;
        if (prop === 'then') return undefined; // never identify as a thenable
        if (prop === 'addListener' || prop === 'removeListener') return function () {};
        if (prop === 'hasListener') return function () { return false; };
        if (prop === 'getRules' || prop === 'getRuleNames') {
          return function (_a, cb) {
            if (typeof cb === 'function') Promise.resolve().then(function () { cb([]); });
            return Promise.resolve([]);
          };
        }
        // Any other access returns a fresh nested auto-stub.
        return makeAutoStub();
      },
      set: function () { return true; },
      has: function () { return true; },
    });
  }

  function wrapChromeWithAutoStub(real) {
    if (!real || typeof real !== 'object') return real;
    // The Proxy target is an EMPTY object, NOT the real chrome. With
    // an empty target there are no own properties, so the JS Proxy
    // invariant "if target has a non-configurable own property X, the
    // get trap must return target[X]" never bites — we can hand back
    // OVERRIDES['scripting'] etc. even though Chromium's stock chrome
    // pins those as read-only non-configurable. Reads from the real
    // chrome happen via the closed-over real reference inside the
    // trap, not via the target.
    var emptyTarget = Object.create(null);
    return new Proxy(emptyTarget, {
      get: function (_t, prop) {
        // Our explicit overrides win first.
        var override = (typeof prop === 'string') ? NEWBRO_OVERRIDES[prop] : undefined;
        // Then whatever Chromium / the library actually installed.
        var v = Reflect.get(real, prop);
        // V23: log every unique top-level chrome.<ns> read so we can
        // see the mechanism extensions actually use (e.g. proxy vs
        // declarativeNetRequest vs runtime.connectNative).
        if (typeof prop === 'string') {
          var kind;
          if (override !== undefined) kind = 'override';
          else if (v !== undefined) kind = (typeof v === 'function' ? 'real-fn' : 'real');
          else kind = 'autostub';
          var rid = '';
          try { rid = (real && real.runtime && real.runtime.id) ? String(real.runtime.id) : ''; }
          catch (e) { swLog('chromeProxy/rid-extract', e); }
          try { trackChromeAccess(rid, prop, kind); }
          catch (e) { swLog('chromeProxy/trackAccess', e); }
        }
        if (override !== undefined) {
          // V28: wrap our own overrides too. Browsec calls
          // chrome.proxy.onError.addListener, which our chrome.proxy
          // override doesn't expose; the fallback turns the missing
          // on<Event> read into a noop stub.
          if (typeof override === 'object' && override !== null) {
            return wrapNsWithEventFallback(override);
          }
          return override;
        }
        if (v !== undefined) {
          // Bind methods that need this to be the real chrome
          // (chrome.tabs.query, chrome.runtime.getManifest, etc.).
          if (typeof v === 'function') return v.bind(real);
          // V27: wrap object namespaces with event-fallback so missing
          // on<Event> properties (e.g. chrome.tabs.onZoomChange) resolve
          // to a noop event stub instead of undefined.
          if (typeof v === 'object') return wrapNsWithEventFallback(v);
          return v;
        }
        if (typeof prop === 'symbol') return undefined;
        return makeAutoStub();
      },
      has: function (_t, prop) {
        if (typeof prop === 'string' && NEWBRO_OVERRIDES[prop]) return true;
        return Reflect.has(real, prop);
      },
      set: function (_t, prop, value) {
        try { return Reflect.set(real, prop, value); }
        catch (e) { swLog('chromeProxy/set:' + String(prop), e); return true; }
      },
      deleteProperty: function (_t, prop) {
        try { return Reflect.deleteProperty(real, prop); }
        catch (e) { swLog('chromeProxy/delete:' + String(prop), e); return true; }
      },
    });
  }

  // Run specific patches first, then wrap.
  try { patch(self.chrome); }
  catch (e) { swLog('main/initial-patch', e); }

  // Diagnostic + recovery for the wrap. Chromium's MV3 SW intrinsics
  // for self.chrome are sometimes pinned non-configurable / non-writable;
  // when that happens, neither defineProperty nor plain assignment can
  // replace self.chrome with our Proxy wrap, and chrome.<ns> reads bypass
  // NEWBRO_OVERRIDES entirely. The user-visible cost is partial — for
  // namespaces where patch() already does a direct sub-property install
  // (chrome.proxy, chrome.userScripts, chrome.scripting, chrome.tabs),
  // those land fine, since pin-ness can differ per sub-property. But
  // namespaces that ONLY live in NEWBRO_OVERRIDES (chrome.webRequest,
  // chrome.runtime, chrome.storage) lose their override.
  //
  // Recovery: when the top-level wrap fails, fall back to installing
  // every NEWBRO_OVERRIDES key as a direct property on self.chrome via
  // defineProperty. Each install is independently tried so a single
  // pinned sub-property doesn't poison the rest.
  var wrapDiag = {
    extId: (self.chrome && self.chrome.runtime && self.chrome.runtime.id) ? String(self.chrome.runtime.id) : '',
    chromeDescBefore: null,
    chromeDescAfter: null,
    definePropertyOk: false,
    definePropertyErr: null,
    assignOk: false,
    assignErr: null,
    finalChromeIsWrapped: false,
    perOverrideInstall: {},
  };
  try {
    var d = Object.getOwnPropertyDescriptor(self, 'chrome');
    if (d) wrapDiag.chromeDescBefore = {
      configurable: !!d.configurable,
      writable: !!d.writable,
      enumerable: !!d.enumerable,
      hasGetter: typeof d.get === 'function',
      hasSetter: typeof d.set === 'function',
      valueType: typeof d.value,
    };
  } catch (e) { swLog('main/wrap-chrome/desc-probe', e); }

  var wrapped = null;
  try {
    if (self.chrome) wrapped = wrapChromeWithAutoStub(self.chrome);
  } catch (e) { swLog('main/wrap-chrome/build', e); }

  if (wrapped) {
    try {
      Object.defineProperty(self, 'chrome', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrapped,
      });
      wrapDiag.definePropertyOk = true;
    } catch (e1) {
      wrapDiag.definePropertyErr = String((e1 && e1.message) || e1).slice(0, 240);
      try {
        self.chrome = wrapped;
        wrapDiag.assignOk = true;
      } catch (e2) {
        wrapDiag.assignErr = String((e2 && e2.message) || e2).slice(0, 240);
      }
    }
  }
  try {
    wrapDiag.finalChromeIsWrapped = self.chrome === wrapped;
  } catch (e) { swLog('main/wrap-chrome/final-cmp', e); }

  // If the top-level wrap didn't take, push each NEWBRO_OVERRIDES key
  // directly onto self.chrome. patch() already covered userScripts /
  // scripting / proxy / tabs; this is the safety net for everything else
  // — most importantly webRequest / runtime / storage, which are the
  // namespaces that hide the SW-bridge events (onAuthRequired, onStartup,
  // onChanged) extensions reach for.
  if (!wrapDiag.finalChromeIsWrapped && self.chrome) {
    var keys = Object.keys(NEWBRO_OVERRIDES);
    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var current;
      try { current = self.chrome[key]; }
      catch (e) { current = undefined; swLog('main/override-current/' + key, e); }
      var subDesc = null;
      try { subDesc = Object.getOwnPropertyDescriptor(self.chrome, key); }
      catch (e) { swLog('main/override-desc/' + key, e); }
      var attempted = { hasCurrent: typeof current !== 'undefined', alreadyOurs: current === NEWBRO_OVERRIDES[key], defineOk: false, defineErr: null, assignOk: false, assignErr: null };
      if (attempted.alreadyOurs) { wrapDiag.perOverrideInstall[key] = 'already-ours'; continue; }
      try {
        Object.defineProperty(self.chrome, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: NEWBRO_OVERRIDES[key],
        });
        attempted.defineOk = self.chrome[key] === NEWBRO_OVERRIDES[key];
      } catch (e3) {
        attempted.defineErr = String((e3 && e3.message) || e3).slice(0, 200);
        try {
          self.chrome[key] = NEWBRO_OVERRIDES[key];
          attempted.assignOk = self.chrome[key] === NEWBRO_OVERRIDES[key];
        } catch (e4) {
          attempted.assignErr = String((e4 && e4.message) || e4).slice(0, 200);
        }
      }
      void subDesc; // keep TS-style happy; ignored in plain JS, here for future structuring
      wrapDiag.perOverrideInstall[key] = attempted;
    }
  }

  // Trap reassignment of self.chrome (some Electron versions do this
  // post-preload). Re-patch + re-wrap when it happens. This is best-
  // effort: if the descriptor above was non-configurable, defineProperty
  // will throw here too — and we just rely on patch() having already
  // done its sub-property installs.
  try {
    var ref = self.chrome;
    Object.defineProperty(self, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function () { return ref; },
      set: function (v) {
        if (v && typeof v === 'object') {
          try { patch(v); }
          catch (e) { swLog('chrome-reassign/patch', e); }
          ref = wrapChromeWithAutoStub(v);
        }
        else { ref = v; }
      }
    });
  } catch (e) {
    swLog('chrome-reassign/defineProperty', e);
    var tries = 0;
    var tick = function () {
      if (self.chrome) { patch(self.chrome); return; }
      if (tries++ < 8) Promise.resolve().then(tick);
    };
    tick();
  }

  try {
    var d2 = Object.getOwnPropertyDescriptor(self, 'chrome');
    if (d2) wrapDiag.chromeDescAfter = {
      configurable: !!d2.configurable,
      writable: !!d2.writable,
      enumerable: !!d2.enumerable,
      hasGetter: typeof d2.get === 'function',
      hasSetter: typeof d2.set === 'function',
    };
  } catch (e) { swLog('main/wrap-chrome/desc-after-probe', e); }

  try { sendPost('wrap-chrome-diag', wrapDiag); }
  catch (e) { swLog('main/wrap-chrome/diag-send', e); }

  // Post-patch diagnostic: ACTUALLY exercise the namespaces we just
  // installed and report the result. Earlier versions only checked
  // typeof, which can lie when Chromium ships getter-backed
  // intrinsics — typeof returns the right thing while the call path
  // still hands back undefined. This version calls getScripts() (TM's
  // crash site), getRegisteredContentScripts(), and a fake proxy
  // settings.get() so the next launch's log directly answers "are
  // our overrides reachable through self.chrome?".
  try {
    var probeExtId = (self.chrome && self.chrome.runtime && self.chrome.runtime.id) ? String(self.chrome.runtime.id) : '';
    Promise.all([
      Promise.resolve().then(function () {
        try { return self.chrome.userScripts.getScripts(); } catch (e) { return { __err: String(e) }; }
      }),
      Promise.resolve().then(function () {
        try { return self.chrome.scripting.getRegisteredContentScripts(); } catch (e) { return { __err: String(e) }; }
      }),
      Promise.resolve().then(function () {
        try { return self.chrome.proxy.settings.get({}); } catch (e) { return { __err: String(e) }; }
      }),
    ]).then(function (results) {
      sendPost('post-patch-state', {
        extId: probeExtId,
        usGetScriptsType: Array.isArray(results[0]) ? 'array' : (results[0] && results[0].__err ? 'error:' + results[0].__err : typeof results[0]),
        scrGetRegisteredType: Array.isArray(results[1]) ? 'array' : (results[1] && results[1].__err ? 'error:' + results[1].__err : typeof results[1]),
        proxyGetType: results[2] && results[2].__err ? 'error:' + results[2].__err : typeof results[2],
        chromeIsOurProxy: (function () {
          try { return self.chrome.userScripts === NEWBRO_OVERRIDES['userScripts']; }
          catch (e) { swLog('post-patch/chromeIsOurProxy-probe', e); return false; }
        })(),
        wrIsOurProxy: (function () {
          try { return self.chrome.webRequest === NEWBRO_OVERRIDES['webRequest']; }
          catch (e) { swLog('post-patch/wrIsOurProxy-probe', e); return false; }
        })(),
        wrOnAuthRequiredType: (function () {
          try { return typeof self.chrome.webRequest.onAuthRequired; }
          catch (e) { return 'error:' + String(e); }
        })(),
        wrOnAuthRequiredAddListenerType: (function () {
          try { return typeof self.chrome.webRequest.onAuthRequired.addListener; }
          catch (e) { return 'error:' + String(e); }
        })(),
      });
    }, function (err) { swLog('post-patch-state/Promise.all-rejected', err); });
  } catch (e) { swLog('post-patch-state/setup', e); }
})();
${SW_SHIM_FOOTER}
`
