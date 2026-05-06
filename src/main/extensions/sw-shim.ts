// Source for the shim we PREPEND directly into MV3 service-worker
// `background.js` files at install time. This is the polyfill that
// Electron 41 should — but doesn't — inject via
// session.registerPreloadScript({ type: 'service-worker' }) for
// chrome-extension service workers.
//
// We can't use `import { ipcRenderer }` here because this code runs
// inside the extension's own JS world (no Electron preload bridge).
// Instead we use `fetch()` to a sentinel host the partition's
// onBeforeRequest listener intercepts in main; the request is
// cancelled before it can leave the process, but the listener's
// inspection of the URL — and request body, for the userScripts
// payload — is enough to drive the action.
//
// Strict mode + IIFE so the shim never leaks identifiers into the
// extension's own global. Idempotent: a reinstall over a previously
// patched background.js sees the magic comment and skips.
//
// Version is bumped on every meaningful change to the source so that
// `injectSwShim` sees the older marker, strips up to the footer line,
// and re-prepends. Without this, an extension that already has e.g.
// V2 in its bg.js stays stuck on V2's polyfill set until reinstall.
//   V1 — chrome.tabs.create / windows.create / runtime.openOptionsPage
//   V2 — added chrome.userScripts and chrome.action badge stubs
//   V3 — added chrome.permissions stub (the dev-mode message went
//        away with V2 but Tampermonkey still refused to inject because
//        chrome.permissions.contains() returned undefined)
//   V4 — force-overwrite chrome.permissions.* (Electron 41 ships a
//        contains() that returns false; the typeof guard was skipping
//        our grant-all stub) and decorated chrome.management.getSelf
//        with hostPermissions: ['<all_urls>'] so Tampermonkey's
//        popup-side access check passes regardless of which API path
//        it takes.
//   V5 — overrode chrome.tabs.query in the SW context to fetch
//        newbro-ipc://active-tab-info and return main's view of the
//        workspace's active tab. Tampermonkey's SW initialises
//        BEFORE our WebContentsView tabs exist; without this it sees
//        zero tabs, caches "no access" forever, and refuses to
//        register or inject userscripts even after the user
//        navigates to a matching URL.
//   V6 — added chrome.scripting.executeScript polyfill that forwards
//        body + target tabIds to main for actual execution. Some
//        MV3 extensions inject userscripts via chrome.scripting
//        instead of chrome.userScripts.

export const SW_SHIM_MAGIC = '// __NEWBRO_SW_SHIM_V6__'

// Markers we know about. Anything matching one of these gets stripped
// and replaced with the current version's source.
export const SW_SHIM_LEGACY_MAGIC = '// __NEWBRO_SW_SHIM_V1__'
export const SW_SHIM_FOOTER = '// __NEWBRO_SW_SHIM_END__'

export const SW_SHIM_HOST = 'newbro-ext-ipc.test'

export const SW_SHIM_SOURCE = `${SW_SHIM_MAGIC}
// Polyfills chrome.tabs.create / chrome.windows.create /
// chrome.runtime.openOptionsPage / chrome.userScripts.* in MV3
// service-worker contexts where Electron 41 doesn't expose them.
// Auto-injected by Newbro at install time. Safe to remove if you
// re-pack the extension yourself.
;(function () {
  'use strict';
  var IPC_HOST = 'https://${SW_SHIM_HOST}';
  function sendGet(action, params) {
    try {
      var qs = '';
      for (var k in params) {
        if (Object.prototype.hasOwnProperty.call(params, k)) {
          qs += (qs ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }
      }
      fetch(IPC_HOST + '/' + action + qs).catch(function () {});
    } catch (_) {}
  }
  function sendPost(action, body) {
    try {
      fetch(IPC_HOST + '/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(function () {});
    } catch (_) {}
  }
  function fakeTab(url, active) {
    return {
      id: -1, index: 0, windowId: -1,
      active: !!active, highlighted: !!active, pinned: false,
      url: url, status: 'loading', incognito: false
    };
  }
  // chrome.userScripts uses the running extension's id as the owner
  // when registering scripts in main. Look it up via chrome.runtime.id.
  function getExtId(c) {
    try { return (c.runtime && c.runtime.id) ? String(c.runtime.id) : ''; } catch (_) { return ''; }
  }

  // In-memory mirror of registered userscripts so chrome.userScripts.getScripts
  // can answer synchronously (Tampermonkey's popup polls this to render
  // its rule list). Keyed by id.
  var REGISTERED = Object.create(null);

  function patch(c) {
    if (!c || typeof c !== 'object') return;

    // ── chrome.tabs ────────────────────────────────────────────────
    var tabs = c.tabs || (c.tabs = {});
    if (typeof tabs.create !== 'function') {
      tabs.create = function (props, cb) {
        var url = (props && typeof props.url === 'string') ? props.url : '';
        var active = !(props && props.active === false);
        if (url) sendGet('open-tab', { url: url, active: active ? '1' : '0' });
        var tab = fakeTab(url, active);
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(tab); });
        return Promise.resolve(tab);
      };
    }

    // chrome.tabs.query — when the SW asks "what's the active tab?",
    // Electron returns either nothing (we observed Tampermonkey
    // initialise BEFORE our tab WebContentsViews exist, so the query
    // is empty) or the popup view itself with a chrome-extension://
    // URL. Either way, Tampermonkey caches "no tabs / no usable URL
    // → no access" and refuses to register or inject anything.
    //
    // Override for {active:true} / {currentWindow:true} /
    // {lastFocusedWindow:true} queries: do an async fetch to
    // newbro-ipc://active-tab-info and return whatever main reports
    // as the workspace's actual active tab. Other queries (specific
    // tabId etc.) fall through to Electron's implementation.
    var origTabsQuery = (typeof tabs.query === 'function') ? tabs.query.bind(tabs) : null;
    tabs.query = function (queryInfo, cb) {
      var wantsActive =
        queryInfo && typeof queryInfo === 'object' &&
        (queryInfo.active === true ||
         queryInfo.currentWindow === true ||
         queryInfo.lastFocusedWindow === true);
      if (wantsActive) {
        var p = fetch('newbro-ipc://active-tab-info')
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var arr = (j && j.tab) ? [j.tab] : [];
            return arr;
          })
          .catch(function () { return []; });
        if (typeof cb === 'function') {
          p.then(function (arr) { cb(arr); });
          return undefined;
        }
        return p;
      }
      if (origTabsQuery) {
        if (typeof cb === 'function') return origTabsQuery(queryInfo, cb);
        return origTabsQuery(queryInfo);
      }
      if (typeof cb === 'function') Promise.resolve().then(function () { cb([]); });
      return Promise.resolve([]);
    };

    // ── chrome.windows ─────────────────────────────────────────────
    var wins = c.windows || (c.windows = {});
    if (typeof wins.create !== 'function') {
      wins.create = function (props, cb) {
        var urls = (props && props.url)
          ? (Array.isArray(props.url) ? props.url : [props.url])
          : [];
        urls.forEach(function (u) { sendGet('open-tab', { url: u, active: '1' }); });
        var win = { id: -1, tabs: urls.map(function (u) { return fakeTab(u, true); }) };
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(win); });
        return Promise.resolve(win);
      };
    }

    // ── chrome.runtime.openOptionsPage ─────────────────────────────
    var rt = c.runtime || (c.runtime = {});
    if (typeof rt.openOptionsPage !== 'function') {
      rt.openOptionsPage = function (cb) {
        try {
          var m = (typeof rt.getManifest === 'function') ? rt.getManifest() : {};
          var page = (typeof m.options_page === 'string')
            ? m.options_page
            : (m.options_ui && m.options_ui.page);
          if (typeof page === 'string' && page && typeof rt.getURL === 'function') {
            sendGet('open-tab', { url: rt.getURL(page), active: '1' });
          }
        } catch (_) {}
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }

    // ── chrome.userScripts ─────────────────────────────────────────
    // Tampermonkey's "Please enable developer mode to allow userscript
    // injection" comes from this API being missing. Stubbing it makes
    // the warning go away AND lets Tampermonkey's popup render its
    // rule list (it queries getScripts() to populate the badge count).
    // Actual script execution happens in main: register() forwards the
    // serialised scripts to the host process, which matches each tab's
    // URL against the registered patterns on every navigation and
    // injects the script body via webContents.executeJavaScript.
    var us = c.userScripts || (c.userScripts = {});
    var extId = getExtId(c);
    if (typeof us.register !== 'function') {
      us.register = function (scripts, cb) {
        var arr = Array.isArray(scripts) ? scripts : [scripts];
        arr.forEach(function (s) { if (s && s.id) REGISTERED[s.id] = s; });
        if (extId && arr.length > 0) sendPost('userscripts-register', { extId: extId, scripts: arr });
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }
    if (typeof us.unregister !== 'function') {
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
    }
    if (typeof us.update !== 'function') {
      us.update = function (scripts, cb) {
        var arr = Array.isArray(scripts) ? scripts : [scripts];
        arr.forEach(function (s) { if (s && s.id) REGISTERED[s.id] = s; });
        if (extId && arr.length > 0) sendPost('userscripts-update', { extId: extId, scripts: arr });
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }
    if (typeof us.getScripts !== 'function') {
      us.getScripts = function (filter, cb) {
        var ids = (filter && Array.isArray(filter.ids)) ? filter.ids : null;
        var out = [];
        for (var id in REGISTERED) {
          if (Object.prototype.hasOwnProperty.call(REGISTERED, id)) {
            if (!ids || ids.indexOf(id) !== -1) out.push(REGISTERED[id]);
          }
        }
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
        return Promise.resolve(out);
      };
    }
    if (typeof us.configureWorld !== 'function') {
      us.configureWorld = function (props, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }
    if (typeof us.getWorldConfigurations !== 'function') {
      us.getWorldConfigurations = function (cb) {
        var out = [];
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(out); });
        return Promise.resolve(out);
      };
    }
    if (typeof us.resetWorldConfiguration !== 'function') {
      us.resetWorldConfiguration = function (worldId, cb) {
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }

    // ── chrome.permissions ─────────────────────────────────────────
    // Tampermonkey calls chrome.permissions.contains({ origins: [url] })
    // before deciding whether to inject; the popup's "no access to
    // this page" message is gated on the result. Force-overwrite —
    // Electron 41 ships a stub for some chrome.permissions methods
    // that returns false, and a typeof-function guard would skip our
    // grant-all and leave Tampermonkey thinking there's no access.
    // Coarse grant-all is appropriate here: extensions live in
    // partitioned sessions the user explicitly chose, and we don't
    // have a per-site grant UX.
    var perms = c.permissions || (c.permissions = {});
    perms.contains = function (p, cb) {
      try {
        sendGet('permission-check', {
          origins: (p && p.origins) ? p.origins.join(',') : '',
          permissions: (p && p.permissions) ? p.permissions.join(',') : '',
        });
      } catch (_) {}
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(true); });
      return Promise.resolve(true);
    };
    perms.request = function (_p, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(true); });
      return Promise.resolve(true);
    };
    perms.remove = function (_p, cb) {
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(true); });
      return Promise.resolve(true);
    };
    perms.getAll = function (cb) {
      var all = { permissions: [], origins: ['<all_urls>'] };
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(all); });
      return Promise.resolve(all);
    };
    if (!perms.onAdded) perms.onAdded = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
    if (!perms.onRemoved) perms.onRemoved = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };

    // ── chrome.management.getSelf ──────────────────────────────────
    // Tampermonkey reads management.getSelf to populate the
    // Enabled/Disabled pill in the popup AND to inspect its own
    // host_permissions for the no-access check on some code paths.
    // Electron 41 has a chrome.management surface but getSelf may not
    // include host_permissions; ensure it does so the access check
    // passes.
    var mgmt = c.management || (c.management = {});
    var origGetSelf = (typeof mgmt.getSelf === 'function') ? mgmt.getSelf.bind(mgmt) : null;
    mgmt.getSelf = function (cb) {
      var manifest = (typeof rt.getManifest === 'function') ? rt.getManifest() : {};
      function decorate(info) {
        info = info || {};
        info.id = extId || info.id || '';
        info.name = info.name || (manifest && manifest.name) || '';
        info.version = info.version || (manifest && manifest.version) || '';
        info.enabled = true;
        info.installType = info.installType || 'normal';
        info.type = info.type || 'extension';
        info.permissions = (manifest && Array.isArray(manifest.permissions)) ? manifest.permissions.slice() : (info.permissions || []);
        info.hostPermissions = ['<all_urls>'];
        info.shortName = info.shortName || (manifest && manifest.short_name) || info.name;
        info.description = info.description || (manifest && manifest.description) || '';
        info.mayDisable = true;
        return info;
      }
      if (origGetSelf) {
        try {
          var maybe = origGetSelf(function (info) {
            if (typeof cb === 'function') Promise.resolve().then(function () { cb(decorate(info)); });
          });
          if (maybe && typeof maybe.then === 'function') {
            return maybe.then(decorate, function () { return decorate({}); });
          }
        } catch (_) {
          var info = decorate({});
          if (typeof cb === 'function') Promise.resolve().then(function () { cb(info); });
          return Promise.resolve(info);
        }
      }
      var info2 = decorate({});
      if (typeof cb === 'function') Promise.resolve().then(function () { cb(info2); });
      return Promise.resolve(info2);
    };

    // ── chrome.scripting.executeScript ─────────────────────────────
    // Some MV3 extensions inject userscripts via chrome.scripting
    // instead of (or in addition to) chrome.userScripts.register.
    // Electron 41 has a partial chrome.scripting; rather than risk
    // breaking what works, we ONLY add executeScript if it's missing,
    // and forward to main via the newbro-ipc channel for execution.
    var scripting = c.scripting || (c.scripting = {});
    if (typeof scripting.executeScript !== 'function') {
      scripting.executeScript = function (injection, cb) {
        try {
          // Best-effort serialize: extract the function body if the
          // caller passed { func, args } and the inline code if they
          // passed { files } we'd need to read from disk in main.
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

    // ── chrome.action badge ────────────────────────────────────────
    // Tampermonkey calls setBadgeText({ text: '3', tabId }) to surface
    // the count of scripts active on the current tab. Electron exposes
    // chrome.action.setBadgeText but we don't render badges on our
    // toolbar icon yet — forward the calls to main so the renderer can
    // overlay a chip on the icon button.
    var act = c.action || (c.action = {});
    if (typeof act.setBadgeText !== 'function') {
      act.setBadgeText = function (details, cb) {
        try {
          sendGet('badge-set', {
            extId: extId,
            text: (details && typeof details.text === 'string') ? details.text : '',
            tabId: (details && details.tabId != null) ? String(details.tabId) : '',
          });
        } catch (_) {}
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }
    if (typeof act.setBadgeBackgroundColor !== 'function') {
      act.setBadgeBackgroundColor = function (details, cb) {
        try {
          var color = '';
          if (details && typeof details.color === 'string') color = details.color;
          else if (details && Array.isArray(details.color)) {
            var rgba = details.color;
            color = 'rgba(' + (rgba[0] || 0) + ',' + (rgba[1] || 0) + ',' + (rgba[2] || 0) + ',' + ((rgba[3] || 255) / 255) + ')';
          }
          sendGet('badge-color', {
            extId: extId,
            color: color,
            tabId: (details && details.tabId != null) ? String(details.tabId) : '',
          });
        } catch (_) {}
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(); });
        return Promise.resolve();
      };
    }
  }
  // Patch whatever's already there.
  try { patch(self.chrome); } catch (_) {}
  // And re-patch every time the chrome namespace is (re-)assigned —
  // Chromium initialises chrome.* AFTER preload returns in some MV3
  // worker contexts, which would otherwise erase our writes.
  try {
    var ref = self.chrome;
    Object.defineProperty(self, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function () { return ref; },
      set: function (v) { ref = v; if (v) patch(v); }
    });
  } catch (_) {
    // Fallback for builds where the SW global makes 'chrome' non-configurable.
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
