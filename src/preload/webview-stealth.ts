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

  log('main-world injection complete');
})();
`

if (STEALTH_ENABLED) {
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

  const paintOverlay = (direction: 'back' | 'forward', progress: number, armed: boolean): void => {
    const el = ensureOverlay()
    const p = Math.max(0, Math.min(1, progress))
    const inset = -HIDDEN_OFFSET_PX + (HIDDEN_OFFSET_PX + REST_INSET_PX) * p
    if (direction === 'back') {
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
    el.style.background = armed ? 'rgba(37,99,235,0.95)' : 'rgba(30,30,30,0.92)'
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
  let direction: 'back' | 'forward' | null = null
  let position = 0                            // accumulated outward distance
  let sessionTimer: ReturnType<typeof setTimeout> | null = null

  const endSession = (): void => {
    sessionTimer = null
    engaged = false
    committed = false
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

      // Already navigated in this swipe — swallow the rest so the page and
      // Chromium's rubber-band stay quiet until the session ends.
      if (committed) { e.preventDefault(); return }

      // Classic line-mode mouse wheels (deltaMode 1/2) aren't swipes.
      if (e.deltaMode !== 0) return

      const dx = e.deltaX
      const dy = e.deltaY
      if (Math.abs(dx) < 1) return
      // Reject mostly-vertical scrolls with tiny horizontal jitter.
      if (!engaged && Math.abs(dx) < Math.abs(dy) * 1.5) return

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

      paintOverlay(direction!, position / TRIGGER_PX, position >= TRIGGER_PX)

      // Eager commit at the threshold (we can't see true finger-lift in
      // time because momentum events keep arriving). Pull-back-to-cancel
      // still works for anything below TRIGGER_PX.
      if (position >= TRIGGER_PX && direction) {
        const dir = direction
        committed = true
        engaged = false
        direction = null
        hideOverlay()
        ipcRenderer.send('newbro-nav', dir)
      }
    },
    { capture: true, passive: false },
  )
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] swipe-gesture wiring failed:', err)
}

// ── Right-click → host context menu ──────────────────────────────────
// We always show our own context menu rather than the page's. Click
// position is captured so main can ask Chromium to inspect the element
// at that point; selection (if any) drives the Copy / Copy-and-search
// rows; nearest <a> / <img> ancestor lights up "Open link in new tab" /
// "Copy image address". The page's own contextmenu handlers (e.g.
// Figma's custom menu) are suppressed via capture-phase preventDefault.
if (STEALTH_ENABLED) try {
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
  }, true)
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] context-menu wiring failed:', err)
}
