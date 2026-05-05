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

const STEALTH_SCRIPT = `
(() => {
  const log = (...a) => { try { console.log('[newbro-stealth]', ...a) } catch (_) {} };
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
        try { console.log('[newbro-stealth] window.close intercepted (tab, no opener)'); } catch (_) {}
      };
      Object.defineProperty(window, 'close', {
        value: noopClose,
        writable: false,
        configurable: false,
      });
    }
  } catch (e) { log('window.close override failed', e); }

  log('main-world injection complete');
})();
`

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

// ── Middle-click on <a> → open in new tab ─────────────────────────────────
// Chromium's native middle-click-opens-link behaviour fires `window.open()`,
// which main's setWindowOpenHandler already redirects to the renderer as a
// new tab. But many sites install their own `mousedown`/`click` handlers on
// links that call `preventDefault()` and do their own navigation (SPA
// routers, click tracking), so middle-click silently does nothing. We walk
// up from the event target to find the nearest <a href>, cancel the event,
// and relay the URL to main which forwards to the renderer as a new tab.
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

// ── Two-finger horizontal swipe → back/forward (overlay rendering) ───────
// Detection runs in the main process via webContents.on('input-event'),
// which sees wheel events BEFORE the page does — independent of any site
// JS that might preventDefault wheel events (Confluence, Jira, GitLab,
// Sheets, etc.) or use non-document scroll containers that make
// document.scrollingElement.scrollLeft a meaningless overscroll signal.
//
// This preload now only renders the visual indicator. Main pushes
// 'newbro-gesture-update' { visible, direction, progress, armed } as the
// gesture progresses; we draw a circle that slides in from the matching
// edge proportional to progress and turns blue once `armed` is true.
//
// The overlay div lives in the page document but is created here in the
// isolated-world preload (so site CSS resets and DOM mutation can't
// fight us) and uses z-index 2147483647 + pointer-events:none so it
// stacks above all page content without intercepting interaction.
try {
  const REST_INSET_PX = 28    // distance from viewport edge once fully in
  const HIDDEN_OFFSET_PX = 64 // distance past viewport edge when invisible

  let overlay: HTMLDivElement | null = null

  const ICON_BACK =
    '<svg width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18 9 12l6-6"/></svg>'
  const ICON_FORWARD =
    '<svg width="33" height="33" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

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

  ipcRenderer.on('newbro-gesture-update', (_e, payload: unknown) => {
    const p = payload as
      | { visible: false }
      | { visible: true; direction: 'back' | 'forward'; progress: number; armed: boolean }
      | null
    if (!p || p.visible === false) {
      hideOverlay()
      return
    }
    const el = ensureOverlay()
    const progress = Math.max(0, Math.min(1, p.progress))
    const inset = -HIDDEN_OFFSET_PX + (HIDDEN_OFFSET_PX + REST_INSET_PX) * progress
    if (p.direction === 'back') {
      el.style.left = `${inset}px`
      el.style.right = ''
      el.innerHTML = ICON_BACK
    } else {
      el.style.right = `${inset}px`
      el.style.left = ''
      el.innerHTML = ICON_FORWARD
    }
    el.style.transform = 'translateY(-50%)'
    el.style.opacity = '1'
    el.style.background = p.armed ? 'rgba(37,99,235,0.95)' : 'rgba(30,30,30,0.92)'
  })
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] swipe-overlay wiring failed:', err)
}

// ── Right-click → host context menu ──────────────────────────────────
// We always show our own context menu rather than the page's. Click
// position is captured so main can ask Chromium to inspect the element
// at that point; selection (if any) drives the Copy / Copy-and-search
// rows; nearest <a> / <img> ancestor lights up "Open link in new tab" /
// "Copy image address". The page's own contextmenu handlers (e.g.
// Figma's custom menu) are suppressed via capture-phase preventDefault.
try {
  window.addEventListener('contextmenu', (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const selection = (window.getSelection?.()?.toString() ?? '').trim()
    const target = e.target as Element | null
    let linkUrl: string | null = null
    let imgUrl: string | null = null
    try {
      const a = (target?.closest?.('a') as HTMLAnchorElement | null) ?? null
      if (a?.href) linkUrl = a.href
    } catch (_) { /* ignore */ }
    try {
      const img = (target?.closest?.('img') as HTMLImageElement | null) ?? null
      if (img?.currentSrc || img?.src) imgUrl = img.currentSrc || img.src
    } catch (_) { /* ignore */ }
    ipcRenderer.send('newbro-context-menu', {
      selection,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
      linkUrl,
      imgUrl,
    })
  }, true)
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] context-menu wiring failed:', err)
}
