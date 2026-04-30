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

// ── Two-finger horizontal swipe → back/forward (Edge / Chrome style) ─────
// Mechanics, matching Edge:
//   - Finger touch-down on the trackpad starts the gesture (main forwards
//     macOS NSEventPhaseBegan via 'newbro-touch-begin'; Chromium's standard
//     wheel events don't expose phase from JS).
//   - As fingers move, deltaX moves a *signed* position counter. The
//     overlay slides in proportional to position — pull back and the
//     overlay slides back out, no timers.
//   - When position passes the commit threshold, the circle gets an
//     accent ring, signalling "release now to navigate".
//   - Touch-end ('newbro-touch-end' from main) is the *only* commit point:
//     if past threshold at that instant, fire navigation immediately;
//     otherwise just hide the overlay.
// Because the overlay lives in the guest DOM, it stacks above the page
// content without needing any cooperation from the main / workspace
// renderer.
try {
  const TRIGGER_PX = 100      // overscroll distance to arm a navigation
  const ENGAGE_PX = 6         // overscroll distance before we engage
  const REST_INSET_PX = 28    // distance from viewport edge once fully in
  const HIDDEN_OFFSET_PX = 64 // distance past viewport edge when invisible

  // Touch state (from main).
  let touchActive = false

  // Engaged-gesture state.
  let engaged = false
  let committed = false // navigation already fired this touch session
  let position = 0 // signed: positive once we've engaged; never negative
  let direction: 'back' | 'forward' | null = null
  let overlay: HTMLDivElement | null = null

  // Navigation history bounds — pushed from main on every did-navigate so
  // the gesture refuses to engage in a direction we can't actually go.
  // Default to "neither", letting the page acquire history before the
  // gesture starts working.
  let canGoBack = false
  let canGoForward = false
  ipcRenderer.on('newbro-nav-state', (_e, state: unknown) => {
    const s = state as { canGoBack?: unknown; canGoForward?: unknown } | null
    canGoBack = s?.canGoBack === true
    canGoForward = s?.canGoForward === true
  })

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
      // Border tracks the icon color so the ring around the circle
      // always reads as part of the same shape.
      'border:2px solid #fff',
      'box-sizing:border-box',
      // No transitions: position, opacity, and background must all
      // track fingers 1:1 — any easing makes the indicator lag.
    ].join(';')
    ;(document.documentElement || document.body).appendChild(el)
    overlay = el
    return el
  }

  const renderOverlay = (): void => {
    if (!direction) return
    const el = ensureOverlay()
    const progress = Math.min(1, position / TRIGGER_PX)
    const armed = position >= TRIGGER_PX
    // Position interpolates from -HIDDEN_OFFSET_PX (off-screen) to
    // +REST_INSET_PX (resting just inside the edge) as progress goes 0→1.
    const inset = -HIDDEN_OFFSET_PX + (HIDDEN_OFFSET_PX + REST_INSET_PX) * progress
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
    el.style.opacity = position > 0 ? '1' : '0'
    el.style.background = armed ? 'rgba(37,99,235,0.95)' : 'rgba(30,30,30,0.92)'
  }

  const hideOverlay = (): void => {
    if (overlay) overlay.style.opacity = '0'
  }

  const resetGesture = (): void => {
    engaged = false
    position = 0
    direction = null
    hideOverlay()
  }

  // Touch begin: start of any two-finger trackpad scroll. We don't engage
  // the overlay yet — only when the user actually overscrolls horizontally.
  ipcRenderer.on('newbro-touch-begin', () => {
    touchActive = true
    engaged = false
    committed = false
    position = 0
    direction = null
  })

  // Touch end: stale signal in this Electron build (delayed by Chromium's
  // momentum-decay wait). We commit eagerly inside the wheel handler when
  // the threshold is crossed; touch-end just tears down anything still
  // showing if the user released without ever crossing.
  ipcRenderer.on('newbro-touch-end', () => {
    touchActive = false
    resetGesture()
  })

  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      // Step aside whenever a page handler on the bubble path already
      // claimed the wheel event for itself (Google Sheets' canvas grid is
      // the canonical case — its page never scrolls horizontally, so to
      // our edge-detection code it would always look like an overscroll
      // and we'd freeze its scrollbars by preventDefault-ing). If the
      // page didn't preventDefault, the event truly is unhandled and we
      // can use it for the back/forward gesture.
      if (e.defaultPrevented) {
        if (engaged) resetGesture()
        return
      }

      // ctrl/cmd+wheel is page zoom; alt/shift can be other tools. Never
      // claim those for the gesture.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        if (engaged) resetGesture()
        return
      }

      // Without a finger-touch context (mouse wheel, or non-macOS) we
      // never engage. macOS sends 'newbro-touch-begin' before the first
      // wheel event of a trackpad gesture.
      if (!touchActive) return

      // After eager commit we keep eating the rest of this touch session's
      // wheel events so any momentum scroll or trailing input can't bounce
      // the page or re-engage the indicator.
      if (committed) {
        e.preventDefault()
        return
      }

      const dx = e.deltaX
      const dy = e.deltaY
      if (Math.abs(dx) < 1) return
      // Reject mostly-vertical gestures so vertical scrolling with tiny
      // horizontal jitter doesn't engage.
      if (!engaged && Math.abs(dx) < Math.abs(dy) * 1.5) return

      // Defer to the nearest horizontally-scrollable ancestor of the
      // cursor target (carousels, wide tables). If one exists under the
      // cursor the user is scrolling it, not navigating history.
      if (!engaged) {
        let scope: HTMLElement | null = e.target as HTMLElement | null
        while (scope && scope !== document.scrollingElement) {
          if (scope.scrollWidth > scope.clientWidth + 1) {
            const ox = window.getComputedStyle(scope).overflowX
            if (ox === 'auto' || ox === 'scroll') return
          }
          scope = scope.parentElement
        }
      }

      const el = document.scrollingElement as HTMLElement | null
      if (!el) return
      const scrollLeft = el.scrollLeft
      const maxScrollLeft = el.scrollWidth - el.clientWidth

      if (!engaged) {
        // Engage only when actually past the document's scroll edge in the
        // wheel direction. dx<0 = scrolling left further = back gesture;
        // dx>0 = scrolling right further = forward gesture.
        let dir: 'back' | 'forward' | null = null
        if (dx < 0 && scrollLeft <= 0) dir = 'back'
        else if (dx > 0 && scrollLeft >= maxScrollLeft - 1) dir = 'forward'
        if (!dir) return
        // Don't engage a direction the tab's history can't actually go.
        if (dir === 'back' && !canGoBack) return
        if (dir === 'forward' && !canGoForward) return
        direction = dir
        position = 0
        engaged = true
      }

      e.preventDefault() // suppress Chromium's rubber-band

      // 1:1 position tracking. dx in the gesture's "outward" direction
      // grows position; reversing shrinks it. Floor at 0 — once you pull
      // the indicator all the way back, the gesture disengages so a fresh
      // overscroll can pick a (possibly different) direction.
      const delta = direction === 'back' ? -dx : dx
      position += delta
      if (position <= 0) {
        position = 0
        // Disengage but stay touch-active: the next overscroll inside
        // this same touch session can re-engage in either direction.
        engaged = false
        direction = null
        hideOverlay()
        // Quick growth past ENGAGE_PX hides the brief flicker before
        // re-engagement; if we're still pulling out, fall through.
        return
      }

      if (engaged && position < ENGAGE_PX) {
        hideOverlay()
        return
      }

      renderOverlay()

      // Eager commit: as soon as the user pushes past the trigger, fire
      // the navigation. We can't reliably observe the actual finger-lift
      // moment in this Electron build (gestureScrollEnd is gated on
      // momentum decay → ~1s late), so the threshold itself is the
      // commit point. The cancel-by-pulling-back gesture still works for
      // anything below the threshold; once you've pushed past it, the
      // commit is irrevocable.
      if (direction && position >= TRIGGER_PX) {
        const dir = direction
        committed = true
        engaged = false
        direction = null
        hideOverlay()
        ipcRenderer.send('newbro-nav', dir)
      }
    },
    // Bubble phase + non-passive: page handlers run first and any that
    // claim the event with preventDefault (Sheets, carousels, etc.) opt
    // themselves out via the `e.defaultPrevented` guard above; we still
    // need passive:false so we can preventDefault the rubber-band when
    // we actually engage.
    { passive: false, capture: false }
  )
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] swipe-gesture wiring failed:', err)
}

// ── Right-click on selected text → host context menu ──────────────────────
// When the user right-clicks with text selected on the page, suppress the
// guest page's own context menu and relay the selection to main so it can
// show a native Electron context menu with Copy / Copy and search.
// Right-click without a selection is left to the page.
try {
  window.addEventListener('contextmenu', (e: MouseEvent) => {
    const selection = (window.getSelection?.()?.toString() ?? '').trim()
    if (!selection) return
    e.preventDefault()
    e.stopPropagation()
    ipcRenderer.send('newbro-context-menu', { selection })
  }, true)
} catch (err) {
  // eslint-disable-next-line no-console
  console.log('[newbro-stealth] context-menu wiring failed:', err)
}
