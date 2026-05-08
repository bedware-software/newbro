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

export const SW_SHIM_MAGIC = '// __NEWBRO_SW_SHIM_V23__'
export const SW_SHIM_LEGACY_MAGIC = '// __NEWBRO_SW_SHIM_V1__'
export const SW_SHIM_FOOTER = '// __NEWBRO_SW_SHIM_END__'

export const SW_SHIM_HOST = 'newbro-ext-ipc.test'

export const SW_SHIM_SOURCE = `${SW_SHIM_MAGIC}
// Polyfills chrome.userScripts + chrome.scripting.executeScript in MV3
// service-worker contexts. The rest of the chrome.* surface is provided
// by electron-chrome-extensions's own preload. Auto-injected by Newbro
// at install time. Safe to remove if you re-pack the extension.
;(function () {
  'use strict';
  var IPC_HOST = 'https://${SW_SHIM_HOST}';
  function sendPost(action, body) {
    try {
      fetch(IPC_HOST + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (_) {}
  }
  function getExtId(c) {
    try { return (c.runtime && c.runtime.id) ? String(c.runtime.id) : ''; } catch (_) { return ''; }
  }

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
        try { sendPost('chrome-access', { items: batch }); } catch (_) {}
      }, 300);
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
          try { url = (typeof input === 'string') ? input : (input && input.url) || String(input); } catch (_) {}
          var ours = isOurIpcUrl(url);
          var t0 = Date.now();
          if (!ours) {
            try {
              sendPost('fetch-start', {
                extId: extId,
                url: url.slice(0, 300),
                method: (init && init.method) || (input && input.method) || 'GET',
              });
            } catch (_) {}
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
              } catch (_) {}
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
              } catch (_) {}
            }
            throw err;
          });
        };
      }
    } catch (_) {}
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
            } catch (_) {}
            return Reflect.construct(target, args);
          },
        });
        try { self.WebSocket = WrappedWS; } catch (_) {}
      }
    } catch (_) {}
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
    } catch (_) {}
    // Install fetch + WebSocket spies once per SW (V23). Done inside
    // patch so the extId is in scope for every logged event.
    try { installNetworkSpies(extId); } catch (_) {}

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
    } catch (_) {
      try { c.userScripts = us; } catch (_) {}
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
    var noopAuthEvent = {
      addListener: function () {},
      removeListener: function () {},
      hasListener: function () { return false; },
    };
    var realWR = c.webRequest;
    var wrEmptyTarget = Object.create(null);
    var newWR = new Proxy(wrEmptyTarget, {
      get: function (_t, prop) {
        if (prop === 'onAuthRequired') return noopAuthEvent;
        if (realWR == null) return undefined;
        var v = Reflect.get(realWR, prop);
        if (typeof v === 'function') return v.bind(realWR);
        return v;
      },
      has: function (_t, prop) {
        if (prop === 'onAuthRequired') return true;
        return realWR != null ? Reflect.has(realWR, prop) : false;
      },
      set: function (_t, prop, value) {
        if (realWR != null) {
          try { return Reflect.set(realWR, prop, value); } catch (_) { /* ignore */ }
        }
        return true;
      },
    });
    NEWBRO_OVERRIDES['webRequest'] = newWR;
    try {
      sendPost('patch-step', {
        extId: extId,
        step: 'webRequest-override-set',
        realWRType: typeof realWR,
        overrideHasOnAuthRequired: typeof newWR.onAuthRequired,
      });
    } catch (_) {}

    // Synchronous diagnostic: log what we put on chrome.userScripts.
    // Fires before TM's init (which is on a microtask) so we always
    // get this lifeline even when TM crashes.
    try {
      sendPost('userscripts-shim-state', {
        extId: extId,
        methods: Object.keys(us),
        executionWorld: us.ExecutionWorld,
      });
    } catch (_) {}
    try {
      sendPost('patch-step', { extId: extId, step: 'after-userScripts-and-webRequest' });
    } catch (_) {}

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
          try { rawGetSelf(function (info) { resolve(info); }); } catch (_) { resolve(undefined); }
        });
      } catch (_) {
        return Promise.resolve(undefined);
      }
    }
    management.getSelf = function (cb) {
      var p = callRawGetSelf().then(decorateSelf, function () { return decorateSelf({}); });
      if (typeof cb === 'function') p.then(function (info) { try { cb(info); } catch (_) {} });
      return p;
    };

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
        } catch (_) {}
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
    var proxyNamespace = { settings: proxySettings }
    NEWBRO_OVERRIDES['proxy'] = proxyNamespace
    try { c.proxy = proxyNamespace; } catch (_) {
      try {
        Object.defineProperty(c, 'proxy', {
          configurable: true, enumerable: true, writable: true,
          value: proxyNamespace,
        });
      } catch (_) { /* OVERRIDES map will satisfy chrome.proxy reads via the wrap */ }
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
    } catch (_) {
      try { c.scripting = scripting; } catch (_) {}
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
      } catch (_) {}
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
  } catch (_) {}
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
  function makeAutoStub() {
    var fn = function autoStub() {
      var cb = arguments.length > 0 ? arguments[arguments.length - 1] : undefined;
      if (typeof cb === 'function') {
        Promise.resolve().then(function () { try { cb(); } catch (_) {} });
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
          try { rid = (real && real.runtime && real.runtime.id) ? String(real.runtime.id) : ''; } catch (_) {}
          try { trackChromeAccess(rid, prop, kind); } catch (_) {}
        }
        if (override !== undefined) return override;
        if (v !== undefined) {
          // Bind methods that need this to be the real chrome
          // (chrome.tabs.query, chrome.runtime.getManifest, etc.).
          if (typeof v === 'function') return v.bind(real);
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
        try { return Reflect.set(real, prop, value); } catch (_) { return true; }
      },
      deleteProperty: function (_t, prop) {
        try { return Reflect.deleteProperty(real, prop); } catch (_) { return true; }
      },
    });
  }

  // Run specific patches first, then wrap.
  try { patch(self.chrome); } catch (_) {}
  try {
    if (self.chrome) {
      var wrapped = wrapChromeWithAutoStub(self.chrome);
      // Replace via defineProperty when possible (lands even if the
      // current self.chrome property is non-writable).
      try {
        Object.defineProperty(self, 'chrome', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: wrapped,
        });
      } catch (_) {
        try { self.chrome = wrapped; } catch (_) {}
      }
    }
  } catch (_) {}

  // Trap reassignment of self.chrome (some Electron versions do this
  // post-preload). Re-patch + re-wrap when it happens.
  try {
    var ref = self.chrome;
    Object.defineProperty(self, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function () { return ref; },
      set: function (v) {
        if (v && typeof v === 'object') { try { patch(v); } catch (_) {} ref = wrapChromeWithAutoStub(v); }
        else { ref = v; }
      }
    });
  } catch (_) {
    var tries = 0;
    var tick = function () {
      if (self.chrome) { patch(self.chrome); return; }
      if (tries++ < 8) Promise.resolve().then(tick);
    };
    tick();
  }

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
        chromeIsOurProxy: (function () { try { return self.chrome.userScripts === NEWBRO_OVERRIDES['userScripts']; } catch (_) { return false; } })(),
        wrIsOurProxy: (function () { try { return self.chrome.webRequest === NEWBRO_OVERRIDES['webRequest']; } catch (_) { return false; } })(),
        wrOnAuthRequiredType: (function () { try { return typeof self.chrome.webRequest.onAuthRequired; } catch (e) { return 'error:' + String(e); } })(),
        wrOnAuthRequiredAddListenerType: (function () { try { return typeof self.chrome.webRequest.onAuthRequired.addListener; } catch (e) { return 'error:' + String(e); } })(),
      });
    }, function () {});
  } catch (_) {}
})();
${SW_SHIM_FOOTER}
`
