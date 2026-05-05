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
// inspection of the URL is enough to drive the action.
//
// Strict mode + IIFE so the shim never leaks identifiers into the
// extension's own global. Idempotent: a reinstall over a previously
// patched background.js sees the magic comment and skips.

export const SW_SHIM_MAGIC = '// __NEWBRO_SW_SHIM_V1__'

export const SW_SHIM_HOST = 'newbro-ext-ipc.test'

export const SW_SHIM_SOURCE = `${SW_SHIM_MAGIC}
// Polyfills chrome.tabs.create / chrome.windows.create /
// chrome.runtime.openOptionsPage in MV3 service-worker contexts where
// Electron 41 doesn't expose them. Auto-injected by Newbro at install
// time. Safe to remove if you re-pack the extension yourself.
;(function () {
  'use strict';
  var IPC_HOST = 'https://${SW_SHIM_HOST}';
  function send(action, params) {
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
  function fakeTab(url, active) {
    return {
      id: -1, index: 0, windowId: -1,
      active: !!active, highlighted: !!active, pinned: false,
      url: url, status: 'loading', incognito: false
    };
  }
  function patch(c) {
    if (!c || typeof c !== 'object') return;
    var tabs = c.tabs || (c.tabs = {});
    if (typeof tabs.create !== 'function') {
      tabs.create = function (props, cb) {
        var url = (props && typeof props.url === 'string') ? props.url : '';
        var active = !(props && props.active === false);
        if (url) send('open-tab', { url: url, active: active ? '1' : '0' });
        var tab = fakeTab(url, active);
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(tab); });
        return Promise.resolve(tab);
      };
    }
    var wins = c.windows || (c.windows = {});
    if (typeof wins.create !== 'function') {
      wins.create = function (props, cb) {
        var urls = (props && props.url)
          ? (Array.isArray(props.url) ? props.url : [props.url])
          : [];
        urls.forEach(function (u) { send('open-tab', { url: u, active: '1' }); });
        var win = { id: -1, tabs: urls.map(function (u) { return fakeTab(u, true); }) };
        if (typeof cb === 'function') Promise.resolve().then(function () { cb(win); });
        return Promise.resolve(win);
      };
    }
    var rt = c.runtime || (c.runtime = {});
    if (typeof rt.openOptionsPage !== 'function') {
      rt.openOptionsPage = function (cb) {
        try {
          var m = (typeof rt.getManifest === 'function') ? rt.getManifest() : {};
          var page = (typeof m.options_page === 'string')
            ? m.options_page
            : (m.options_ui && m.options_ui.page);
          if (typeof page === 'string' && page && typeof rt.getURL === 'function') {
            send('open-tab', { url: rt.getURL(page), active: '1' });
          }
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
`
