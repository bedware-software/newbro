// Session-level preload installed on every partitioned webview session via
// session.setPreloads(). Even when the preload itself runs in an isolated
// world (contextIsolation=true — Electron's default which cannot reliably
// be disabled on <webview> tags), `webFrame.executeJavaScript()` evaluates
// the passed string in the page's MAIN WORLD, before any page script runs.
//
// The injected code is puppeteer-stealth-style fingerprint evasions needed
// to prevent Google's sign-in JS from detecting the embedded Chromium and
// rejecting form submission with "Couldn't sign you in — This browser or
// app may not be secure."

import { webFrame, ipcRenderer } from 'electron'

// Diagnostic marker so we can confirm in the webview's DevTools console that
// this preload is actually being loaded. If you see "[newbro-stealth] preload
// loaded" appear in the webview's console, the preload ran. If you also see
// "[newbro-stealth] main-world injection complete", webFrame.executeJavaScript
// successfully reached the page's main world and all the property overrides
// below are in effect.
// eslint-disable-next-line no-console
console.log('[newbro-stealth] preload loaded')

// True for the kind of pages this preload exists to stealth: real
// http(s) and file:// content. False for extension UI (popup, options,
// background page), Chromium internals, devtools, and about:blank — any
// of these would either be UNAFFECTED by our overrides or actively
// BROKEN by them:
//   - The window.close() neuter would block an extension popup from
//     closing itself.
//   - The window.chrome stub would shadow the real chrome.* surface
//     that Electron has installed for the extension, breaking
//     chrome.runtime messaging, chrome.storage, chrome.tabs, etc.
//   - The contextmenu / wheel / mouse listeners send IPC messages that
//     main's tab handlers route through `wcIdToTabId` — extension
//     popups and chrome:// pages aren't in that map, so the IPCs are
//     no-ops at best, misleading at worst (the right-click handler in
//     particular synthesises a tab context menu against the wrong tab).
const STEALTH_ENABLED = (() => {
  const proto = location.protocol
  if (
    proto === 'chrome-extension:' ||
    proto === 'devtools:' ||
    proto === 'chrome:' ||
    proto === 'chrome-search:' ||
    proto === 'chrome-untrusted:'
  ) {
    // eslint-disable-next-line no-console
    console.log('[newbro-stealth] skipped for', proto, location.href)
    return false
  }
  // about:blank is the initial-document URL for OAuth popups — those
  // navigate to a real https origin almost immediately so we DO want
  // stealth there.
  return true
})()

const PSEUDO_FULLSCREEN_EVENT = '__newbro_pseudo_fullscreen__'

const PSEUDO_FULLSCREEN_SCRIPT = `
(() => {
  const EVENT_NAME = ${JSON.stringify(PSEUDO_FULLSCREEN_EVENT)};
  const INSTALL_KEY = '__newbroPseudoFullscreenInstalled';
  const ROOT_ATTR = 'data-newbro-pseudo-fullscreen';
  const TARGET_ATTR = 'data-newbro-pseudo-fullscreen-target';
  const STYLE_ID = 'newbro-pseudo-fullscreen-style';

  if (window[INSTALL_KEY]) return;
  Object.defineProperty(window, INSTALL_KEY, { value: true, configurable: false });

  let fullscreenElement = null;
  let fullscreenTarget = null;

  const log = (...a) => { console.log('[newbro-fullscreen]', ...a); };
  const getDescriptor = (owner, prop) => {
    try { return Object.getOwnPropertyDescriptor(owner, prop); }
    catch (_) { return undefined; }
  };

  const native = {
    requestFullscreen: Element.prototype.requestFullscreen,
    webkitRequestFullscreen: Element.prototype.webkitRequestFullscreen,
    webkitRequestFullScreen: Element.prototype.webkitRequestFullScreen,
    mozRequestFullScreen: Element.prototype.mozRequestFullScreen,
    msRequestFullscreen: Element.prototype.msRequestFullscreen,
    exitFullscreen: Document.prototype.exitFullscreen,
    webkitExitFullscreen: Document.prototype.webkitExitFullscreen,
    webkitCancelFullScreen: Document.prototype.webkitCancelFullScreen,
    mozCancelFullScreen: Document.prototype.mozCancelFullScreen,
    msExitFullscreen: Document.prototype.msExitFullscreen,
    fullscreenElement: getDescriptor(Document.prototype, 'fullscreenElement')?.get,
    webkitFullscreenElement: getDescriptor(Document.prototype, 'webkitFullscreenElement')?.get,
    mozFullScreenElement: getDescriptor(Document.prototype, 'mozFullScreenElement')?.get,
    msFullscreenElement: getDescriptor(Document.prototype, 'msFullscreenElement')?.get,
    fullscreenEnabled: getDescriptor(Document.prototype, 'fullscreenEnabled')?.get,
    webkitFullscreenEnabled: getDescriptor(Document.prototype, 'webkitFullscreenEnabled')?.get,
    mozFullScreenEnabled: getDescriptor(Document.prototype, 'mozFullScreenEnabled')?.get,
    msFullscreenEnabled: getDescriptor(Document.prototype, 'msFullscreenEnabled')?.get,
    webkitIsFullScreen: getDescriptor(Document.prototype, 'webkitIsFullScreen')?.get,
    mozFullScreen: getDescriptor(Document.prototype, 'mozFullScreen')?.get,
  };

  const describeElement = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    let rect = null;
    try {
      const r = element.getBoundingClientRect();
      rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      };
    } catch (_) { /* ignore */ }
    return {
      tag: String(element.tagName || '').toLowerCase(),
      id: typeof element.id === 'string' ? element.id : '',
      classes: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
      rect,
    };
  };

  const getMetrics = () => ({
    href: location.href,
    viewport: {
      width: window.innerWidth || document.documentElement.clientWidth || 0,
      height: window.innerHeight || document.documentElement.clientHeight || 0,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    screen: {
      width: window.screen?.width || 0,
      height: window.screen?.height || 0,
      availWidth: window.screen?.availWidth || 0,
      availHeight: window.screen?.availHeight || 0,
    },
    element: describeElement(fullscreenElement),
    target: describeElement(fullscreenTarget),
  });

  const notifyHost = (active, phase) => {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { active, phase, metrics: getMetrics() } }));
    } catch (err) {
      log('notify failed', err);
    }
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      'html[' + ROOT_ATTR + '], html[' + ROOT_ATTR + '] body { overflow:hidden !important; background:#000 !important; }',
      '[' + TARGET_ATTR + '] { position:fixed !important; inset:0 !important; width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important; margin:0 !important; padding:0 !important; overflow:hidden !important; transform:none !important; z-index:2147483647 !important; background:#000 !important; box-sizing:border-box !important; }',
      'video[' + TARGET_ATTR + '] { object-fit:contain !important; }',
    ].join('\\n');
    (document.head || document.documentElement).appendChild(style);
  };

  const resolveFullscreenTarget = (element) => {
    return element;
  };

  const applyFullscreenAttributes = () => {
    try { fullscreenTarget?.setAttribute(TARGET_ATTR, ''); } catch (_) { /* ignore */ }
  };

  const refreshLayout = () => {
    if (!fullscreenTarget) return;
    applyFullscreenAttributes();
  };

  const nudgePageLayout = () => {
    const run = () => {
      refreshLayout();
      try { window.dispatchEvent(new Event('resize')); } catch (_) { /* ignore */ }
    };
    run();
    try { requestAnimationFrame(refreshLayout); } catch (_) { /* ignore */ }
    setTimeout(run, 80);
    setTimeout(run, 250);
    setTimeout(run, 700);
  };

  const fireFullscreenChange = (target) => {
    const names = [
      'fullscreenchange',
      'webkitfullscreenchange',
      'mozfullscreenchange',
      'MSFullscreenChange',
    ];
    Promise.resolve().then(() => {
      for (const name of names) {
        try {
          const event = new Event(name, { bubbles: true });
          (target || document).dispatchEvent(event);
        } catch (_) { /* ignore */ }
      }
    });
  };

  const clearTarget = () => {
    const oldElement = fullscreenElement;
    const oldTarget = fullscreenTarget;
    fullscreenElement = null;
    fullscreenTarget = null;
    try { oldTarget?.removeAttribute(TARGET_ATTR); } catch (_) { /* ignore */ }
    try { document.documentElement.removeAttribute(ROOT_ATTR); } catch (_) { /* ignore */ }
    notifyHost(false, 'leave');
    fireFullscreenChange(oldElement || oldTarget);
  };

  const enterPseudoFullscreen = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return Promise.reject(new TypeError('Element.requestFullscreen called on a non-element'));
    }
    const target = resolveFullscreenTarget(element);
    if (fullscreenElement === element && fullscreenTarget === target) {
      nudgePageLayout();
      return Promise.resolve();
    }
    if (fullscreenTarget) clearTarget();
    fullscreenElement = element;
    fullscreenTarget = target;
    ensureStyle();
    applyFullscreenAttributes();
    try { document.documentElement.setAttribute(ROOT_ATTR, ''); } catch (_) { /* ignore */ }
    notifyHost(true, 'enter');
    nudgePageLayout();
    fireFullscreenChange(element);
    return Promise.resolve();
  };

  const exitPseudoFullscreen = () => {
    if (!fullscreenTarget) return Promise.resolve();
    clearTarget();
    return Promise.resolve();
  };

  const defineGetter = (prop, getter) => {
    try {
      Object.defineProperty(Document.prototype, prop, { configurable: true, get: getter });
    } catch (err) {
      log('getter patch failed', prop, err);
    }
  };

  defineGetter('fullscreenElement', function () {
    return this === document && fullscreenElement ? fullscreenElement : native.fullscreenElement?.call(this) ?? null;
  });
  defineGetter('webkitFullscreenElement', function () {
    return this === document && fullscreenElement ? fullscreenElement : native.webkitFullscreenElement?.call(this) ?? null;
  });
  defineGetter('mozFullScreenElement', function () {
    return this === document && fullscreenElement ? fullscreenElement : native.mozFullScreenElement?.call(this) ?? null;
  });
  defineGetter('msFullscreenElement', function () {
    return this === document && fullscreenElement ? fullscreenElement : native.msFullscreenElement?.call(this) ?? null;
  });
  defineGetter('fullscreenEnabled', function () {
    return this === document ? true : native.fullscreenEnabled?.call(this) ?? true;
  });
  defineGetter('webkitFullscreenEnabled', function () {
    return this === document ? true : native.webkitFullscreenEnabled?.call(this) ?? true;
  });
  defineGetter('mozFullScreenEnabled', function () {
    return this === document ? true : native.mozFullScreenEnabled?.call(this) ?? true;
  });
  defineGetter('msFullscreenEnabled', function () {
    return this === document ? true : native.msFullscreenEnabled?.call(this) ?? true;
  });
  defineGetter('webkitIsFullScreen', function () {
    return this === document && fullscreenElement ? true : native.webkitIsFullScreen?.call(this) ?? false;
  });
  defineGetter('mozFullScreen', function () {
    return this === document && fullscreenElement ? true : native.mozFullScreen?.call(this) ?? false;
  });

  const request = function () { return enterPseudoFullscreen(this); };
  const exit = function () {
    if (this === document && fullscreenTarget) return exitPseudoFullscreen();
    if (native.exitFullscreen) return native.exitFullscreen.call(this);
    return Promise.resolve();
  };

  try { Element.prototype.requestFullscreen = request; } catch (err) { log('requestFullscreen patch failed', err); }
  try { Element.prototype.webkitRequestFullscreen = request; } catch (_) { /* ignore */ }
  try { Element.prototype.webkitRequestFullScreen = request; } catch (_) { /* ignore */ }
  try { Element.prototype.mozRequestFullScreen = request; } catch (_) { /* ignore */ }
  try { Element.prototype.msRequestFullscreen = request; } catch (_) { /* ignore */ }
  try { Document.prototype.exitFullscreen = exit; } catch (err) { log('exitFullscreen patch failed', err); }
  try { Document.prototype.webkitExitFullscreen = exit; } catch (_) { /* ignore */ }
  try { Document.prototype.webkitCancelFullScreen = exit; } catch (_) { /* ignore */ }
  try { Document.prototype.mozCancelFullScreen = exit; } catch (_) { /* ignore */ }
  try { Document.prototype.msExitFullscreen = exit; } catch (_) { /* ignore */ }

  document.addEventListener('keydown', (event) => {
    if (!fullscreenTarget || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    exitPseudoFullscreen();
  }, true);

  window.addEventListener('resize', refreshLayout, true);

  window.addEventListener('pagehide', () => {
    if (fullscreenTarget) notifyHost(false, 'pagehide');
  }, true);
})();
`

function installPseudoFullscreen(): void {
  let active = false
  try {
    window.addEventListener(PSEUDO_FULLSCREEN_EVENT, (event: Event) => {
      const detail = (event as CustomEvent<{ active?: unknown; phase?: unknown; metrics?: unknown }>).detail
      const next = detail?.active === true
      active = next
      ipcRenderer.send('newbro-pseudo-fullscreen', {
        active: next,
        phase: typeof detail?.phase === 'string' ? detail.phase : undefined,
        metrics: detail?.metrics,
      })
    }, true)
    window.addEventListener('pagehide', () => {
      if (!active) return
      active = false
      ipcRenderer.send('newbro-pseudo-fullscreen', false)
    }, true)
    webFrame.executeJavaScript(PSEUDO_FULLSCREEN_SCRIPT, false).catch((err) => {
      // eslint-disable-next-line no-console
      console.log('[newbro-fullscreen] executeJavaScript rejected:', err)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[newbro-fullscreen] install threw:', err)
  }
}

const STEALTH_SCRIPT = `
(() => {
  // No try/catch around console.log — under any normal page state it
  // won't throw, and if it does the failure should surface, not be
  // silenced (we get the page's window.onerror via Electron anyway).
  const log = (...a) => { console.log('[newbro-stealth]', ...a); };
  log('main-world injection starting');

  // 1. navigator.webdriver → undefined. Override on the prototype so the
  //    own-property check \`'webdriver' in navigator && !navigator.hasOwnProperty('webdriver')\`
  //    still passes (which matches real Chrome behavior).
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) { log('webdriver override failed', e); }

  // 2. window.chrome — real Chrome has a rich object. Electron provides a
  //    minimal stub, which is a detection signal. Fill it in comprehensively.
  try {
    if (!window.chrome) window.chrome = {};
    const chrome = window.chrome;

    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null; },
        getIsInstalled: function () { return false; },
        runningState: function () { return 'cannot_run'; },
      };
    }

    if (!chrome.runtime) {
      chrome.runtime = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WINDOWS: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      };
    }

    if (typeof chrome.csi !== 'function') {
      chrome.csi = function () {
        return { onloadT: Date.now(), pageT: performance.now(), startE: Date.now() - 500, tran: 15 };
      };
    }

    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = function () {
        const t = performance.timeOrigin / 1000;
        return {
          commitLoadTime: t, connectionInfo: 'h2',
          finishDocumentLoadTime: 0, finishLoadTime: 0,
          firstPaintAfterLoadTime: 0, firstPaintTime: 0,
          navigationType: 'Other', npnNegotiatedProtocol: 'h2',
          requestTime: t, startLoadTime: t,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        };
      };
    }
  } catch (e) { log('chrome object override failed', e); }

  // 3. window.outerHeight / outerWidth — webviews have outerHeight===innerHeight
  //    because there's no browser chrome around them. Real Chrome has ~85px of
  //    tabs/url-bar chrome. Fake the delta.
  try {
    if (window.outerHeight - window.innerHeight < 10) {
      Object.defineProperty(window, 'outerHeight', {
        get: function () { return window.innerHeight + 85; },
        configurable: true,
      });
    }
    if (window.outerWidth - window.innerWidth < 5) {
      Object.defineProperty(window, 'outerWidth', {
        get: function () { return window.innerWidth; },
        configurable: true,
      });
    }
  } catch (e) { log('outer dimensions override failed', e); }

  // 4. navigator.plugins — empty plugin array is a classic embedded-Chromium
  //    signal. Real Chrome freezes 3 PDF-related plugins.
  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const mkPlugin = (name, filename, desc) => ({
        name: name, filename: filename, description: desc, length: 1,
        0: { type: 'application/pdf', suffixes: 'pdf', description: desc, enabledPlugin: null },
      });
      const arr = [
        mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
        mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      ];
      arr.item = function (i) { return arr[i] || null; };
      arr.namedItem = function (n) { return arr.find(function (p) { return p.name === n; }) || null; };
      arr.refresh = function () {};
      Object.defineProperty(navigator, 'plugins', {
        get: function () { return arr; },
        configurable: true,
      });
    }
  } catch (e) { log('plugins override failed', e); }

  // 5. navigator.languages — empty array is a signal. Ensure non-empty.
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: function () { return ['en-US', 'en']; },
        configurable: true,
      });
    }
  } catch (e) { log('languages override failed', e); }

  // 6. navigator.permissions.query — real Chrome special-cases 'notifications'
  //    permission state. Headless detects this.
  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery(params);
      };
    }
  } catch (e) { log('permissions.query override failed', e); }

  // 7. navigator.userAgentData — Client Hints API. We disabled UACH at the
  //    Chromium command-line level (so sec-ch-ua headers are never sent,
  //    which is what lets Google sign-in succeed); but that also wipes
  //    navigator.userAgentData, which is exactly what the Chrome Web Store
  //    and Edge Add-ons pages check to decide whether to enable the
  //    "Add to Chrome" / "Get" button. With no userAgentData they show
  //    "Item currently unavailable" / "Incompatible with your browser".
  //
  //    Fake a shape that matches what stable Chrome/Edge reports, including
  //    a plausible getHighEntropyValues() implementation. The install flow
  //    we actually use does not rely on any Chrome-private API that could
  //    be detected later, so the spoof is sufficient for the store pages
  //    to let us through.
  try {
    if (!navigator.userAgentData) {
      const uaMatch = /Chrom(?:e|ium)\\/([0-9]+)/.exec(navigator.userAgent);
      const majorVersion = (uaMatch && uaMatch[1]) || '132';
      const fullVersion = majorVersion + '.0.0.0';
      const platformName = (() => {
        const p = navigator.platform || '';
        if (/win/i.test(p)) return 'Windows';
        if (/mac/i.test(p)) return 'macOS';
        return 'Linux';
      })();
      const brands = [
        { brand: 'Chromium', version: majorVersion },
        { brand: 'Google Chrome', version: majorVersion },
        { brand: 'Not_A Brand', version: '24' },
      ];
      const highEntropy = {
        architecture: 'x86',
        bitness: '64',
        brands: brands,
        fullVersionList: brands.map(function (b) { return { brand: b.brand, version: fullVersion }; }),
        mobile: false,
        model: '',
        platform: platformName,
        platformVersion: '15.0.0',
        uaFullVersion: fullVersion,
        wow64: false,
      };
      const fake = {
        brands: brands,
        mobile: false,
        platform: platformName,
        getHighEntropyValues: function (hints) {
          const filtered = { brands: brands, mobile: false, platform: platformName };
          for (const h of (hints || [])) {
            if (highEntropy[h] !== undefined) filtered[h] = highEntropy[h];
          }
          return Promise.resolve(filtered);
        },
        toJSON: function () { return { brands: brands, mobile: false, platform: platformName }; },
      };
      Object.defineProperty(navigator, 'userAgentData', {
        get: function () { return fake; },
        configurable: true,
      });
    }
  } catch (e) { log('userAgentData override failed', e); }

  // 8. window.close() — only neuter for tabs, NOT popups. Pages call
  //    window.close() to dismiss themselves when they were opened as
  //    popups (OAuth callbacks are the canonical case: Figma's
  //    /finish_google_sso, GitHub's device-auth handoff, etc.). For a
  //    real popup BrowserWindow that's the right behavior — let it close.
  //    But when the same page lands in a regular tab (e.g. user navigated
  //    there directly), window.close() in our setup has been observed to
  //    take down the parent workspace BrowserWindow with it, costing the
  //    user every other tab. We detect "regular tab" by window.opener
  //    being null — popups always have an opener, tabs don't.
  try {
    const isPopup = window.opener != null;
    if (!isPopup) {
      const noopClose = function () {
        console.log('[newbro-stealth] window.close intercepted (tab, no opener)');
      };
      Object.defineProperty(window, 'close', {
        value: noopClose,
        writable: false,
        configurable: false,
      });
    }
  } catch (e) { log('window.close override failed', e); }

  // 9. window.focus() — same "neuter for tabs, keep for popups" treatment as
  //    window.close above. A page calling window.focus() asks the browser to
  //    raise its top-level window; in this app each workspace is its own
  //    BrowserWindow, and focusing a background tab's WebContentsView pulls
  //    that whole window to the foreground on Windows (the same mechanism we
  //    disable for navigations via focusOnNavigation:false in tab-views.ts).
  //    So a background workspace whose page re-focuses itself — a Jenkins tab
  //    whose session expired re-focusing to show a login form is the case
  //    that prompted this — yanks the user away from whatever they were doing.
  //    Real browsers ignore programmatic window.focus() from a background tab;
  //    we do too. Popups (window.opener != null, e.g. OAuth windows) legitimately
  //    raise themselves, so they keep the native behaviour.
  try {
    const isPopup = window.opener != null;
    if (!isPopup) {
      const noopFocus = function () {
        console.log('[newbro-stealth] window.focus intercepted (tab, no opener)');
      };
      Object.defineProperty(window, 'focus', {
        value: noopFocus,
        writable: false,
        configurable: false,
      });
    }
  } catch (e) { log('window.focus override failed', e); }

  log('main-world injection complete');
})();
`

if (STEALTH_ENABLED) {
  installPseudoFullscreen()
  try {
    // webFrame.executeJavaScript runs the code string in the frame's MAIN world
    // (world 0), even if the preload itself is in an isolated world. This is
    // the documented way to inject into the page context from a preload.
    webFrame.executeJavaScript(STEALTH_SCRIPT, false).catch((err) => {
      // eslint-disable-next-line no-console
      console.log('[newbro-stealth] executeJavaScript rejected:', err)
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[newbro-stealth] executeJavaScript threw:', err)
  }
}

// ── Mouse side buttons → host navigation ──────────────────────────────────
// Chromium inside a tab's guest webContents doesn't reliably surface
// XButton1 / XButton2 (mouse back/forward) as a WM_APPCOMMAND, so neither
// `BrowserWindow.on('app-command')` nor `webContents.on('app-command')` fire
// when the guest page has focus. We listen here in the preload (isolated
// world — DOM events still reach us) and relay the intent to main via
// `ipcRenderer.send`, which ipcMain in main/tab-views.ts turns into
// goBack/goForward on the sender's WebContents.
//
// We cover the full button-press lifecycle (mousedown / mouseup / auxclick)
// in the capture phase so page scripts can't swallow the event first, and
// preventDefault on all three to suppress any site handler that might try
// to use these buttons for its own UI (e.g. Jira keyboard/mouse shortcuts).
if (STEALTH_ENABLED) {
  try {
    const relay = (e: MouseEvent): void => {
      // MouseEvent.button: 3 = XButton1 (back), 4 = XButton2 (forward)
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'mouseup') {
        ipcRenderer.send('newbro-nav', e.button === 3 ? 'back' : 'forward')
      }
    }
    window.addEventListener('mousedown', relay, true)
    window.addEventListener('mouseup', relay, true)
    window.addEventListener('auxclick', relay, true)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[newbro-stealth] mouse-nav wiring failed:', err)
  }
}

// ── Middle-click on <a> → open in new tab ─────────────────────────────────
// Chromium's native middle-click-opens-link behaviour fires `window.open()`,
// which main's setWindowOpenHandler already redirects to the renderer as a
// new tab. But many sites install their own `mousedown`/`click` handlers on
// links that call `preventDefault()` and do their own navigation (SPA
// routers, click tracking), so middle-click silently does nothing. We walk
// up from the event target to find the nearest <a href>, cancel the event,
// and relay the URL to main which forwards to the renderer as a new tab.
if (STEALTH_ENABLED) {
  try {
    const findAnchor = (target: EventTarget | null): HTMLAnchorElement | null => {
      let node = target as Node | null
      while (node) {
        if (node instanceof HTMLAnchorElement && node.href) return node
        node = (node as Node).parentNode
      }
      return null
    }
    const middleClickRelay = (e: MouseEvent): void => {
      if (e.button !== 1) return
      const a = findAnchor(e.target)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'auxclick') {
        ipcRenderer.send('newbro-open-in-new-tab', a.href)
      }
    }
    window.addEventListener('mousedown', middleClickRelay, true)
    window.addEventListener('auxclick', middleClickRelay, true)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[newbro-stealth] middle-click wiring failed:', err)
  }
}

// ── Two-finger horizontal swipe → back/forward ──────────────────────────
// Detection AND overlay rendering both live here, in the page's isolated-
// world preload. It must: the only place the horizontal scroll delta
// (WheelEvent.deltaX) is available is the DOM. Electron's main-process
// `webContents.on('input-event')` delivers the base InputEvent — `type`
// and `modifiers` only, with NO deltaX/deltaY/hasPreciseScrollingDeltas —
// so a main-side wheel reader literally can't measure the swipe (this was
// the bug: it read `wheel.deltaX`, always got undefined → 0, and never
// engaged).
//
// We listen on `window` in the CAPTURE phase with passive:false so we see
// the deltas before any page handler AND can preventDefault to stop the
// page scrolling / Chromium rubber-banding while the swipe is in flight.
// preventDefault does not stop us receiving the event, so sites that
// preventDefault wheels (Confluence/Jira/GitLab) can't hide the gesture
// from us. We accumulate dx directly rather than checking a scroll-edge,
// so non-document scroll containers don't matter.
//
// Main pushes the current history bounds via 'newbro-gesture-bounds' so we
// don't engage a direction the tab can't go; on commit we reuse the
// existing 'newbro-nav' channel (the same one the mouse side-buttons use).
//
// The overlay div lives in the page document, created here so site CSS
// resets can't fight it; z-index 2147483647 + pointer-events:none stacks
// it above all content without intercepting interaction.
if (STEALTH_ENABLED) try {
  const TRIGGER_PX = 100      // accumulated dx that fires navigation
  const ENGAGE_PX = 6         // min accumulated dx before the overlay shows
  const SESSION_GAP_MS = 140  // wheel inactivity that ends a swipe session
  const REST_INSET_PX = 28    // distance from viewport edge once fully in
  const HIDDEN_OFFSET_PX = 64 // distance past viewport edge when invisible

  let overlay: HTMLDivElement | null = null

  // Icons are DOM-built, NOT innerHTML strings: pages that enforce Trusted
  // Types via CSP (Gmail / all Google apps) make every string→innerHTML
  // assignment throw, and that exception used to kill the wheel handler
  // mid-swipe — the gesture engaged, preventDefault'ed the scroll, then
  // died before the commit, so swipes felt completely dead on those sites.
  const makeChevron = (d: string): SVGSVGElement => {
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', '33')
    svg.setAttribute('height', '33')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2.5')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
    return svg
  }
  const ICON_BACK = makeChevron('M15 18 9 12l6-6')
  const ICON_FORWARD = makeChevron('m9 18 6-6-6-6')

  const ensureOverlay = (): HTMLDivElement => {
    if (overlay && overlay.isConnected) return overlay
    const el = document.createElement('div')
    el.setAttribute('data-newbro-swipe', '')
    el.style.cssText = [
      'position:fixed',
      'top:50%',
      'width:72px',
      'height:72px',
      'border-radius:9999px',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'pointer-events:none',
      'z-index:2147483647',
      'opacity:0',
      'color:#fff',
      'background:rgba(30,30,30,0.92)',
      'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
      'border:2px solid #fff',
      'box-sizing:border-box',
      // No transitions: every property must track the finger 1:1.
    ].join(';')
    ;(document.documentElement || document.body).appendChild(el)
    overlay = el
    return el
  }

  const hideOverlay = (): void => {
    if (overlay) overlay.style.opacity = '0'
  }

  const paintOverlay = (direction: 'back' | 'forward', progress: number): void => {
    const el = ensureOverlay()
    const p = Math.max(0, Math.min(1, progress))
    const inset = -HIDDEN_OFFSET_PX + (HIDDEN_OFFSET_PX + REST_INSET_PX) * p
    const icon = direction === 'back' ? ICON_BACK : ICON_FORWARD
    if (direction === 'back') {
      el.style.left = `${inset}px`
      el.style.right = ''
    } else {
      el.style.right = `${inset}px`
      el.style.left = ''
    }
    if (el.firstChild !== icon) el.replaceChildren(icon)
    el.style.transform = 'translateY(-50%)'
    el.style.opacity = '1'
  }

  // History bounds, pushed from main on every navigation (emitNavState).
  let canGoBack = false
  let canGoForward = false
  ipcRenderer.on('newbro-gesture-bounds', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { canGoBack?: unknown; canGoForward?: unknown }
    canGoBack = p.canGoBack === true
    canGoForward = p.canGoForward === true
  })

  // Per-swipe state machine.
  let engaged = false
  let committed = false                       // already navigated this session
  let committedDxSign = 0                     // dx sign of the committed swipe (its tail keeps it)
  let tailMinAbsDx = Infinity                 // decay floor of the momentum tail since commit
  let direction: 'back' | 'forward' | null = null
  let position = 0                            // accumulated outward distance
  let sessionTimer: ReturnType<typeof setTimeout> | null = null

  const endSession = (): void => {
    sessionTimer = null
    engaged = false
    committed = false
    committedDxSign = 0
    tailMinAbsDx = Infinity
    direction = null
    position = 0
    hideOverlay()
  }

  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      // A burst of wheel events is one swipe; a gap ends it. This is how we
      // re-arm `committed` and tear down the overlay after the finger lifts
      // (incl. the trailing momentum events macOS keeps sending).
      if (sessionTimer) clearTimeout(sessionTimer)
      sessionTimer = setTimeout(endSession, SESSION_GAP_MS)

      // Modifier wheels are zoom / alt-tools — never claim them.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        if (engaged) { engaged = false; direction = null; position = 0; hideOverlay() }
        return
      }

      // Classic line-mode mouse wheels (deltaMode 1/2) aren't swipes.
      if (e.deltaMode !== 0) return

      const dx = e.deltaX
      const dy = e.deltaY
      const adx = Math.abs(dx)

      // Gesture nav is for TRACKPADS only. A mouse scroll wheel — including a
      // horizontal tilt wheel — must never flip history; the user drives
      // back/forward with the side buttons and expects the wheel to scroll
      // and nothing else. On Windows both devices report pixel mode
      // (deltaMode 0), so the line-mode check above can't tell them apart.
      // Chromium can: a precision touchpad is pixel-precise and derives the
      // legacy wheelDeltaX as exactly -deltaX*3, whereas a hardware wheel
      // notch is quantized to 120-unit ticks (~100px/tick on Windows, ratio
      // ~1.2 — never 3). If wheelDeltaX is readable and doesn't match the
      // touchpad's ×3 relationship, it's a wheel: drop it so only fingers
      // navigate. (max(6, adx) tolerance ignores sub-pixel rounding on the
      // touchpad while the wheel's mismatch is on the order of |dx|*1.8.)
      const wdx = (e as WheelEvent & { wheelDeltaX?: number }).wheelDeltaX
      if (typeof wdx === 'number' && Math.abs(wdx + dx * 3) > Math.max(6, adx)) {
        if (engaged) { engaged = false; direction = null; position = 0; hideOverlay() }
        return
      }

      // Already navigated in this swipe — swallow the macOS momentum tail
      // so it can't scroll the page or re-trigger a second navigation. But
      // on in-page navigators (Gmail and other hash/pushState SPAs) the
      // document — and this state machine — survives the commit, and every
      // swallowed event also extends the session, so without an escape
      // hatch a NEW swipe begun during the tail is eaten too, forcing a
      // multi-second pause between consecutive gestures. (Real navigations
      // never hit this: the fresh document resets the state.) Momentum
      // physics gives us the escape: tail deltas decay toward zero and
      // never flip sign, so a sign flip or a delta rising well above the
      // decay floor is a new finger-down swipe — reset and engage normally.
      if (committed) {
        // Clearly-vertical events aren't tail (the tail inherits the
        // swipe's horizontal dominance) — that's the user scrolling.
        if (Math.abs(dy) > adx * 2) return
        const isNewSwipe =
          (dx !== 0 && Math.sign(dx) !== committedDxSign) ||
          (adx > 8 && adx > tailMinAbsDx * 3)
        if (!isNewSwipe) {
          if (adx >= 1 && adx < tailMinAbsDx) tailMinAbsDx = adx
          e.preventDefault()
          return
        }
        committed = false
        committedDxSign = 0
        tailMinAbsDx = Infinity
      }

      if (adx < 1) return
      // Reject mostly-vertical scrolls with tiny horizontal jitter.
      if (!engaged && adx < Math.abs(dy) * 1.5) return

      if (!engaged) {
        // dx<0 = fingers moving right (content right) = "back"; dx>0 = "forward".
        const dir: 'back' | 'forward' = dx < 0 ? 'back' : 'forward'
        if (dir === 'back' && !canGoBack) return
        if (dir === 'forward' && !canGoForward) return
        direction = dir
        position = 0
        engaged = true
      }

      // We own the gesture now — stop the page from scrolling sideways and
      // stop Chromium's native overscroll animation.
      e.preventDefault()

      const delta = direction === 'back' ? -dx : dx
      position += delta
      if (position <= 0) {
        // Pulled all the way back — disengage so a fresh overscroll within
        // the same session can pick a (possibly different) direction.
        position = 0
        engaged = false
        direction = null
        hideOverlay()
        return
      }
      if (position < ENGAGE_PX) {
        hideOverlay()
        return
      }

      // Eager commit at the threshold (we can't see true finger-lift in
      // time because momentum events keep arriving). Pull-back-to-cancel
      // still works for anything below TRIGGER_PX. Commit BEFORE painting
      // so an overlay/DOM failure can never swallow the navigation.
      if (position >= TRIGGER_PX && direction) {
        const dir = direction
        committed = true
        // 'back' engages on dx<0, so its tail keeps dx<0; mirror for 'forward'.
        committedDxSign = dir === 'back' ? -1 : 1
        tailMinAbsDx = Infinity
        engaged = false
        direction = null
        hideOverlay()
        ipcRenderer.send('newbro-nav', dir)
        return
      }

      paintOverlay(direction!, position / TRIGGER_PX)
    },
    { capture: true, passive: false },
  )
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] swipe-gesture wiring failed:', err)
}

// ── Right-click → host context menu ──────────────────────────────────
// We show our own context menu, but only when the page hasn't claimed the
// right-click for itself — matching how Chrome/Firefox behave. We listen in
// the BUBBLE phase (not capture) so every page handler runs first; if any of
// them called preventDefault to show a custom menu (Google Docs, Figma,
// some web apps), `e.defaultPrevented` is already true and we bail, letting
// the site's menu stand. Otherwise we cancel the default (suppressing the
// native Chromium menu) and raise ours. Click position is captured so main
// can inspect the element; selection drives the Copy / Copy-and-search rows;
// nearest <a> / <img> ancestor lights up "Open link in new tab" / "Copy
// image address".
if (STEALTH_ENABLED) try {
  window.addEventListener('contextmenu', (e: MouseEvent) => {
    // The page already handled this right-click with its own menu — defer to
    // it like a normal browser would.
    if (e.defaultPrevented) return
    e.preventDefault()
    const selection = (window.getSelection?.()?.toString() ?? '').trim()
    const target = e.target as Element | null
    let linkUrl: string | null = null
    let imgUrl: string | null = null
    try {
      const a = (target?.closest?.('a') as HTMLAnchorElement | null) ?? null
      if (a?.href) linkUrl = a.href
    } catch (err) {
      console.error('[newbro-stealth] context-menu link lookup threw:', err)
    }
    try {
      const img = (target?.closest?.('img') as HTMLImageElement | null) ?? null
      if (img?.currentSrc || img?.src) imgUrl = img.currentSrc || img.src
    } catch (err) {
      console.error('[newbro-stealth] context-menu img lookup threw:', err)
    }
    ipcRenderer.send('newbro-context-menu', {
      selection,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      linkUrl,
      imgUrl,
    })
  }, false)
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] context-menu wiring failed:', err)
}

// ── Password manager ─────────────────────────────────────────────────
// Runs in Electron's isolated preload world: it can inspect/fill the DOM, but
// the page's JavaScript cannot access the credential objects or ipcRenderer.
// Main independently derives this frame's origin + profile partition before it
// returns any secret, so a compromised page cannot ask for another site's data.
// Some Electron versions can run the same preload once from webPreferences and
// once from the session registration; keep this feature idempotent per frame.
const passwordManagerGlobal = globalThis as typeof globalThis & { __newbroPasswordManagerInstalled?: boolean }
const PASSWORD_MANAGER_ENABLED = STEALTH_ENABLED
  && (location.protocol === 'https:' || location.protocol === 'http:')
  && !passwordManagerGlobal.__newbroPasswordManagerInstalled
if (PASSWORD_MANAGER_ENABLED) passwordManagerGlobal.__newbroPasswordManagerInstalled = true
if (PASSWORD_MANAGER_ENABLED) try {
  interface PagePasswordEntry {
    id: string
    username: string
    password: string
  }
  interface PagePasswordLookup {
    enabled: boolean
    autofill: 'automatic' | 'on-focus' | 'off'
    entries: PagePasswordEntry[]
  }
  interface PendingPasswordOffer {
    origin: string
    username: string
    kind: 'save' | 'update'
  }

  let lookupPromise: Promise<PagePasswordLookup> | null = null
  let chooserHost: HTMLElement | null = null
  let savePromptHost: HTMLElement | null = null
  let lastCandidateSignature = ''
  let lastCandidateAt = 0
  let automaticScanScheduled = false
  let automaticRetryTimers: Array<ReturnType<typeof setTimeout>> = []
  const autoFilled = new WeakSet<HTMLInputElement>()

  const lookup = (): Promise<PagePasswordLookup> => {
    if (!lookupPromise) {
      lookupPromise = ipcRenderer.invoke('passwords:lookup-for-page') as Promise<PagePasswordLookup>
    }
    return lookupPromise
  }

  const isVisible = (input: HTMLInputElement): boolean => {
    const rect = input.getBoundingClientRect()
    const style = getComputedStyle(input)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }

  const usernameInputFor = (passwordInput: HTMLInputElement): HTMLInputElement | null => {
    const root: ParentNode = passwordInput.form ?? document
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input'))
    const candidates = inputs.filter((input) => {
      if (input === passwordInput || input.disabled || input.readOnly || !isVisible(input)) return false
      const type = (input.type || 'text').toLowerCase()
      return ['text', 'email', 'tel', ''].includes(type)
    })
    return candidates.find((input) => input.autocomplete.toLowerCase() === 'username')
      ?? candidates.filter((input) => input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      ?? candidates[candidates.length - 1]
      ?? null
  }

  const setInputValue = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    else input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const fillEntry = (passwordInput: HTMLInputElement, entry: PagePasswordEntry): void => {
    const usernameInput = usernameInputFor(passwordInput)
    if (usernameInput && (!usernameInput.value || usernameInput.value === entry.username)) {
      setInputValue(usernameInput, entry.username)
    }
    setInputValue(passwordInput, entry.password)
    passwordInput.setAttribute('data-newbro-password-filled', 'true')
    autoFilled.add(passwordInput)
    chooserHost?.remove()
    chooserHost = null
    void ipcRenderer.invoke('passwords:mark-used', entry.id)
  }

  const closeChooser = (): void => {
    chooserHost?.remove()
    chooserHost = null
  }

  const showChooser = (passwordInput: HTMLInputElement, entries: PagePasswordEntry[]): void => {
    closeChooser()
    if (entries.length === 0 || !passwordInput.isConnected) return
    const rect = passwordInput.getBoundingClientRect()
    const host = document.createElement('div')
    host.setAttribute('data-newbro-password-ui', 'chooser')
    host.style.cssText = `position:fixed;left:${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px;top:${Math.min(window.innerHeight - 80, rect.bottom + 6)}px;width:320px;z-index:2147483647;`
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      :host{all:initial;color-scheme:light dark}
      .box{overflow:hidden;border:1px solid rgba(127,127,127,.34);border-radius:10px;background:Canvas;color:CanvasText;box-shadow:0 12px 34px rgba(0,0,0,.24);font:13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .head{padding:9px 12px 7px;color:GrayText;font-size:11px;font-weight:650;letter-spacing:.02em}
      button{all:unset;box-sizing:border-box;display:flex;width:100%;align-items:center;gap:10px;padding:9px 12px;cursor:pointer}
      button:hover,button:focus{background:color-mix(in srgb, Highlight 13%, Canvas)}
      .key{display:grid;width:27px;height:27px;place-items:center;border-radius:7px;background:color-mix(in srgb, Highlight 16%, Canvas);font-size:13px}
      .user{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
      .dots{color:GrayText;letter-spacing:2px}
    `
    const box = document.createElement('div')
    box.className = 'box'
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = entries.length === 1 ? 'Saved password' : 'Choose an account'
    box.appendChild(head)
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.innerHTML = '<span class="key">&#128273;</span><span class="user"></span><span class="dots">••••••</span>'
      const user = button.querySelector<HTMLElement>('.user')
      if (user) user.textContent = entry.username
      button.addEventListener('pointerdown', (event) => event.preventDefault())
      button.addEventListener('click', () => fillEntry(passwordInput, entry))
      box.appendChild(button)
    }
    shadow.append(style, box)
    document.documentElement.appendChild(host)
    chooserHost = host
  }

  const handlePasswordInput = async (passwordInput: HTMLInputElement, allowAutomatic: boolean): Promise<void> => {
    if (
      passwordInput.disabled
      || passwordInput.readOnly
      || passwordInput.autocomplete.toLowerCase() === 'new-password'
      || !isVisible(passwordInput)
    ) return
    const result = await lookup()
    if (!result.enabled || result.entries.length === 0 || !passwordInput.isConnected) return
    if (allowAutomatic && result.autofill === 'automatic' && !passwordInput.value) {
      const username = usernameInputFor(passwordInput)?.value.trim()
      const matches = username
        ? result.entries.filter((entry) => entry.username === username)
        : result.entries
      if (matches.length === 1) {
        fillEntry(passwordInput, matches[0])
        return
      }
    }
    if (result.autofill !== 'off') showChooser(passwordInput, result.entries)
  }

  const showSavePrompt = (offer: PendingPasswordOffer): void => {
    savePromptHost?.remove()
    const host = document.createElement('div')
    host.setAttribute('data-newbro-password-ui', 'save-prompt')
    host.style.cssText = 'position:fixed;right:16px;top:16px;width:330px;z-index:2147483647;'
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `
      :host{all:initial;color-scheme:light dark}
      .box{border:1px solid rgba(127,127,127,.34);border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 14px 38px rgba(0,0,0,.26);padding:14px;font:13px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .title{font-size:14px;font-weight:700;margin-bottom:3px}.copy{color:GrayText;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .actions{display:flex;justify-content:flex-end;gap:7px;margin-top:13px}button{all:unset;border-radius:7px;padding:7px 11px;cursor:pointer;font-weight:650}
      .quiet:hover{background:color-mix(in srgb, CanvasText 8%, Canvas)}.primary{background:Highlight;color:HighlightText}.primary:hover{filter:brightness(.94)}
    `
    const box = document.createElement('div')
    box.className = 'box'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = offer.kind === 'update' ? 'Update saved password?' : 'Save password?'
    const copy = document.createElement('div')
    copy.className = 'copy'
    copy.textContent = `${offer.username} · ${new URL(offer.origin).host}`
    const actions = document.createElement('div')
    actions.className = 'actions'
    const dismiss = document.createElement('button')
    dismiss.className = 'quiet'
    dismiss.textContent = 'Not now'
    const save = document.createElement('button')
    save.className = 'primary'
    save.textContent = offer.kind === 'update' ? 'Update' : 'Save'
    dismiss.addEventListener('click', () => {
      void ipcRenderer.invoke('passwords:dismiss-pending')
      host.remove()
      if (savePromptHost === host) savePromptHost = null
    })
    save.addEventListener('click', async () => {
      save.disabled = true
      save.textContent = offer.kind === 'update' ? 'Updating…' : 'Saving…'
      try {
        await ipcRenderer.invoke('passwords:commit-pending')
        lookupPromise = null
        host.remove()
        if (savePromptHost === host) savePromptHost = null
      } catch {
        save.disabled = false
        save.textContent = 'Try again'
      }
    })
    actions.append(dismiss, save)
    box.append(title, copy, actions)
    shadow.append(style, box)
    document.documentElement.appendChild(host)
    savePromptHost = host
  }

  const candidateFrom = (scope: ParentNode): { username: string; password: string } | null => {
    const passwords = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .filter((input) => !input.disabled && !input.readOnly && !!input.value)
    if (passwords.length === 0) return null
    const current = passwords.find((input) => input.autocomplete.toLowerCase() === 'current-password')
    const matchingNew = passwords.find((input, index) =>
      input.autocomplete.toLowerCase() === 'new-password'
      && passwords.some((other, otherIndex) => otherIndex !== index && other.value === input.value),
    )
    // Password-change forms usually contain current + repeated new-password
    // fields. Save the confirmed new value, not the old current password.
    const passwordInput = matchingNew ?? current ?? passwords[0]
    const usernameInput = usernameInputFor(passwordInput)
    const username = usernameInput?.value?.trim() ?? ''
    if (!username || !passwordInput.value) return null
    return { username, password: passwordInput.value }
  }

  const offerCandidate = async (scope: ParentNode): Promise<void> => {
    const candidate = candidateFrom(scope)
    if (!candidate) return
    const signature = `${candidate.username}\u0000${candidate.password}`
    const now = Date.now()
    if (signature === lastCandidateSignature && now - lastCandidateAt < 1500) return
    lastCandidateSignature = signature
    lastCandidateAt = now
    const saved = await lookup()
    if (saved.entries.some((entry) => entry.username === candidate.username && entry.password === candidate.password)) return
    const offer = await ipcRenderer.invoke('passwords:offer-save', candidate) as PendingPasswordOffer | null
    if (offer) setTimeout(() => showSavePrompt(offer), 450)
  }

  window.addEventListener('focusin', (event) => {
    const input = event.target
    if (input instanceof HTMLInputElement && input.type.toLowerCase() === 'password') {
      void handlePasswordInput(input, false)
    } else {
      closeChooser()
    }
  }, true)
  window.addEventListener('pointerdown', (event) => {
    if (chooserHost && event.target !== chooserHost) closeChooser()
  }, true)
  window.addEventListener('submit', (event) => {
    const form = event.target
    if (form instanceof HTMLFormElement) void offerCandidate(form)
  }, true)
  window.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const submit = target?.closest?.('button[type="submit"],input[type="submit"]')
    if (submit) {
      const form = (submit as HTMLButtonElement | HTMLInputElement).form
      if (form) void offerCandidate(form)
    }
  }, true)

  const scanForAutomaticFill = (): void => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    if (inputs.length === 0) return
    void lookup().then((result) => {
      // Never silently fill a subframe. Cross-origin sign-in frames still get
      // the chooser after an explicit focus, but automatic filling is limited
      // to the top document to reduce invisible-iframe credential exposure.
      if (window.top !== window || !result.enabled || result.autofill !== 'automatic' || result.entries.length === 0) return
      for (const input of inputs) {
        if (autoFilled.has(input) || input.value) continue
        void handlePasswordInput(input, true)
      }
    })
  }

  const scheduleAutomaticFill = (withRetries = false): void => {
    if (!automaticScanScheduled) {
      automaticScanScheduled = true
      requestAnimationFrame(() => {
        automaticScanScheduled = false
        scanForAutomaticFill()
      })
    }
    // Dynamic login panels often insert hidden inputs and reveal them one or
    // two layout frames later. The mutation fires too early for isVisible(),
    // so retry after CSS transitions/layout have settled instead of waiting
    // for the user to focus the password field.
    if (withRetries) {
      for (const timer of automaticRetryTimers) clearTimeout(timer)
      automaticRetryTimers = []
      for (const delay of [80, 240, 600]) {
        automaticRetryTimers.push(setTimeout(() => scheduleAutomaticFill(false), delay))
      }
    }
  }

  const startPasswordManager = (): void => {
    scheduleAutomaticFill(true)
    const observer = new MutationObserver(() => scheduleAutomaticFill(true))
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'type'],
    })
    // Covers panels revealed by event handlers whose DOM/style mutations land
    // before the browser has assigned non-zero bounds to their inputs.
    window.addEventListener('click', () => scheduleAutomaticFill(true), true)
    if (window.top === window) {
      void ipcRenderer.invoke('passwords:get-pending').then((offer: PendingPasswordOffer | null) => {
        if (offer) showSavePrompt(offer)
      })
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPasswordManager, { once: true })
  } else {
    startPasswordManager()
  }
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-passwords] preload wiring failed:', err)
}
