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

export const SW_SHIM_MAGIC = '// __NEWBRO_SW_SHIM_V11__'
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

  var REGISTERED = Object.create(null);

  function patch(c) {
    if (!c || typeof c !== 'object') return;

    var extId = getExtId(c);

    // ── chrome.userScripts ─────────────────────────────────────────
    // FORCE-overwrite. Electron 41 ships partial chrome.userScripts
    // stubs that may throw "developer mode required" or no-op
    // silently; the typeof guard would skip our impl and Tampermonkey
    // would either bail (and never call register, exactly what we
    // observed) or fall back to chrome.scripting.executeScript which
    // also doesn't work. The library doesn't implement userScripts
    // so we're not clobbering anything important.
    var us = c.userScripts || (c.userScripts = {});
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

    // ── chrome.proxy / chrome.privacy / chrome.browsingData ────────
    // Electron 41 doesn't expose these and Browsec (and other VPN /
    // privacy extensions) crashes on first access reading e.g.
    // chrome.proxy.settings. Stub them so the SW doesn't die at
    // background.js:190 with "Cannot read properties of undefined
    // (reading 'settings')". The stubs don't actually do anything —
    // Browsec won't be able to set the system proxy via chrome.proxy
    // — but at least its UI will load.
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
    if (!c.proxy) c.proxy = {};
    if (!c.proxy.settings) c.proxy.settings = chromeSettingStub({ mode: 'system' });
    if (!c.proxy.onProxyError) c.proxy.onProxyError = noopEvent;

    if (!c.privacy) c.privacy = {};
    if (!c.privacy.network) c.privacy.network = {
      networkPredictionEnabled: chromeSettingStub(true),
      webRTCIPHandlingPolicy: chromeSettingStub('default'),
    };
    if (!c.privacy.services) c.privacy.services = {
      alternateErrorPagesEnabled: chromeSettingStub(true),
      autofillEnabled: chromeSettingStub(true),
      autofillAddressEnabled: chromeSettingStub(true),
      autofillCreditCardEnabled: chromeSettingStub(true),
      passwordSavingEnabled: chromeSettingStub(true),
      safeBrowsingEnabled: chromeSettingStub(true),
      searchSuggestEnabled: chromeSettingStub(true),
      spellingServiceEnabled: chromeSettingStub(true),
      translationServiceEnabled: chromeSettingStub(true),
    };
    if (!c.privacy.websites) c.privacy.websites = {
      thirdPartyCookiesAllowed: chromeSettingStub(true),
      hyperlinkAuditingEnabled: chromeSettingStub(true),
      referrersEnabled: chromeSettingStub(true),
      doNotTrackEnabled: chromeSettingStub(false),
      protectedContentEnabled: chromeSettingStub(true),
    };

    if (!c.browsingData) c.browsingData = {
      remove: function (_options, _dataToRemove, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      removeCache: function (_options, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      removeCookies: function (_options, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      removeHistory: function (_options, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      },
      settings: function (cb) {
        var s = { options: { since: 0, originTypes: { unprotectedWeb: true } }, dataToRemove: {}, dataRemovalPermitted: {} };
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(s); });
        return Promise.resolve(s);
      },
    };

    // ── chrome.scripting.executeScript ─────────────────────────────
    // Force-overwrite for the same reason as userScripts.
    var scripting = c.scripting || (c.scripting = {});
    {
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
    }
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
  try { patch(self.chrome); } catch (_) {}
  try {
    var ref = self.chrome;
    Object.defineProperty(self, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function () { return ref; },
      set: function (v) { ref = v; if (v) patch(v); }
    });
  } catch (_) {
    var tries = 0;
    var tick = function () {
      if (self.chrome) { patch(self.chrome); return; }
      if (tries++ < 8) Promise.resolve().then(tick);
    };
    tick();
  }
})();
${SW_SHIM_FOOTER}
`
