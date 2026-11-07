#!/usr/bin/env node
// Records the screen while scripts/white-frame/app.cjs goes back and forth
// between two black pages on different sites, and labels every frame of the
// page's area:
//   B  black — a page
//   W  white (r, g and b all >= 250) over 90% of it — the blank white frame
//   w  white over 2–90% of it
//   R  the window's dark red, through a see-through view
//   .  anything else
// A scenario whose frames mostly lack the window's red border, or a page,
// is reported as NO CAPTURE rather than clean: the recording wasn't of it.
//
//   node scripts/white-frame/record.mjs [scenario ...] [--fps=60] [--out=dir]
//   node scripts/white-frame/record.mjs --newbro   (after npm run build)
//
// Runs every scenario (see SCENARIOS) unless some are named; --newbro records
// the built Newbro instead (NEWBRO_SCENARIOS). Needs ffmpeg on
// PATH. Linux: an X display — it starts Xvfb on :99 when DISPLAY is unset;
// macOS: Screen Recording permission for the terminal; Windows: nothing more.
// Frames it labels W, plus a black and a red one, are saved as PNGs under
// out/white-frame/<platform>/ (or --out).

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import zlib from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const electronPath = createRequire(import.meta.url)('electron')

const SCENARIOS = {
  // History navigations: Chromium keeps the old page up (paint holding) only
  // when the user interacted with it, so these show whatever the new view has.
  'back':                { how: 'back' },
  'back-sandboxed':      { how: 'back', sandbox: true },
  'back-fixed':          { how: 'back', fix: true },
  'back-held':           { how: 'back', hold: true },
  // The page navigates itself, without a user gesture.
  'js':                  { how: 'js' },
  'js-sandboxed':        { how: 'js', sandbox: true },
  'js-fixed':            { how: 'js', fix: true },
  // A clicked link: the page has user activation, Chromium holds it.
  'click':               { how: 'click' },
  // A slow site: its first paint 300 ms after the commit.
  'slow-back':           { how: 'back', stallMs: 300, navs: 6 },
  'slow-back-sandboxed': { how: 'back', sandbox: true, stallMs: 300, navs: 6 },
  'slow-back-fixed':     { how: 'back', fix: true, stallMs: 300, navs: 6 },
  'slow-back-held':      { how: 'back', hold: true, stallMs: 300, navs: 6 },
}

// --newbro: the built Newbro itself (npm run build first), a tab of it going
// between the two pages — Newbro's own back/forward, the page sending itself
// elsewhere, a clicked link (scripts/white-frame/newbro-driver.cjs).
const NEWBRO_SCENARIOS = {
  'newbro-back':  { how: 'back' },
  'newbro-js':    { how: 'js' },
  'newbro-click': { how: 'click' },
}

const args = process.argv.slice(2)
const NEWBRO = args.includes('--newbro')
const scenarios = NEWBRO ? NEWBRO_SCENARIOS : SCENARIOS
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : def
}
const FPS = Number(flag('fps', 60))
const OUT = flag('out', join(here, '../../out/white-frame', process.platform))
const names = args.filter((a) => !a.startsWith('--'))
for (const n of names) if (!scenarios[n]) throw new Error(`unknown scenario ${n}`)

/** out/main/white-frame.js: the driver, then Newbro's main as built. */
function newbroMain() {
  const main = join(here, '../../out/main/index.js')
  if (!existsSync(main)) throw new Error('no out/main/index.js: run npm run build first')
  const wrapper = join(dirname(main), 'white-frame.js')
  writeFileSync(wrapper, `require(${JSON.stringify(join(here, 'newbro-driver.cjs'))})\nrequire('./index.js')\n`)
  return wrapper
}

// ── PNG (no dependencies) ────────────────────────────────────────────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function png(w, h, rgb) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Frame labels ─────────────────────────────────────────────────────────
const isRed = (r, g, b) => r >= 0x28 && r <= 0x60 && g <= 0x18 && b <= 0x18

/** Labels the view's area of a frame of the window (w x h, the view `inset`
 *  from its edges); `border` says whether the window's red margin is there —
 *  if not, the capture isn't showing this window. */
function label(frame, w, h, inset) {
  const m = Math.min(8, Math.floor(inset / 2))
  let n = 0, white = 0, pure = 0, black = 0, red = 0
  for (let y = inset + m; y < h - inset - m; y += 4) {
    for (let x = inset + m, i = (y * w + x) * 3; x < w - inset - m; x += 4, i += 12) {
      const r = frame[i], g = frame[i + 1], b = frame[i + 2]
      n++
      if (r >= 250 && g >= 250 && b >= 250) { white++; if (r === 255 && g === 255 && b === 255) pure++ }
      else if (r <= 12 && g <= 12 && b <= 12) black++
      else if (isRed(r, g, b)) red++
    }
  }
  let edge = 0, edgeRed = 0
  const y = Math.floor(inset / 2)
  for (let x = inset; inset && x < w - inset; x += 8) {
    const i = (y * w + x) * 3
    edge++
    if (isRed(frame[i], frame[i + 1], frame[i + 2])) edgeRed++
  }
  const lab = white / n >= 0.9 ? 'W' : white / n >= 0.02 ? 'w' : black / n >= 0.9 ? 'B' : red / n >= 0.9 ? 'R' : '.'
  // No inset: Newbro's own window around the tab, no border to check.
  return { lab, pure: pure / n, border: !inset || edgeRed / edge >= 0.8 }
}

// ── Capture ──────────────────────────────────────────────────────────────
let macScreen = null
function captureInput({ x, y, w, h }) {
  if (process.platform === 'linux') {
    return ['-f', 'x11grab', '-framerate', String(FPS), '-video_size', `${w}x${h}`, '-i', `${process.env.DISPLAY}+${x},${y}`]
  }
  if (process.platform === 'win32') {
    return ['-f', 'gdigrab', '-framerate', String(FPS), '-draw_mouse', '0',
      '-offset_x', String(x), '-offset_y', String(y), '-video_size', `${w}x${h}`, '-i', 'desktop']
  }
  if (macScreen === null) {
    const list = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { encoding: 'utf8', timeout: 20_000 })
    const m = /\[(\d+)\] Capture screen 0/.exec(list.stderr ?? '')
    console.log(`avfoundation devices:\n${(list.stderr ?? '').trim() || list.error}`)
    macScreen = m ? m[1] : 'Capture screen 0'
  }
  return ['-f', 'avfoundation', '-framerate', String(FPS), '-capture_cursor', '0', '-pixel_format', 'bgr0', '-i', `${macScreen}:none`,
    '-vf', `crop=${w}:${h}:${x}:${y}`]
}

function startXvfb() {
  if (process.platform !== 'linux' || process.env.DISPLAY) return null
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  process.env.DISPLAY = ':99'
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'])
  return xvfb
}

function runScenario(name, options) {
  return new Promise((resolve) => {
    const goDir = mkdtempSync(join(tmpdir(), 'white-frame-'))
    const goFile = join(goDir, 'go')
    const go = () => writeFileSync(goFile, 'go')
    const main = NEWBRO ? newbroMain() : join(here, 'app.cjs')
    const app = spawn(electronPath, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), main], {
      env: { ...process.env, WF_OPTIONS: JSON.stringify(options), WF_GO_FILE: goFile, ELECTRON_ENABLE_LOGGING: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const appLog = []
    let rect = null
    let ffmpeg = null
    let ffmpegErr = ''
    let pending = Buffer.alloc(0)
    const labels = []
    const saved = []
    let started = 0
    let goSent = false
    let finished = false
    let navs = 0
    const notes = []

    let borderless = 0
    let ended = false
    let endedAt = 0
    const onFrame = (frame) => {
      if (ended) return // the window is going away
      const { lab, pure, border } = label(frame, rect.w, rect.h, rect.inset)
      labels.push(lab)
      if (!border) { borderless++; if (process.env.WF_DEBUG) console.log(`   [${name}] frame ${labels.length - 1} (${lab}) without border`) }
      if (!started) {
        started = Date.now()
        console.log(`   [${name}] first frame`)
      }
      if (!goSent && labels.length >= 20) {
        goSent = true
        console.log(`   [${name}] go`)
        go()
      }
      const keep = lab === 'W' ? saved.filter((s) => s.lab === 'W').length < 4
        : (lab === 'B' || lab === 'R') && !saved.some((s) => s.lab === lab)
      if (keep && goSent) saved.push({ lab, index: labels.length - 1, pure, png: png(rect.w, rect.h, Buffer.from(frame)) })
    }

    // No frames at all (capture refused, wrong screen): don't hold the app
    // for good — let it run, the result says so.
    let noFrames = null
    const startCapture = () => {
      noFrames = setTimeout(() => {
        if (!goSent) {
          goSent = true
          go()
        }
      }, 20_000)
      // passthrough on macOS: every captured frame once — by default ffmpeg
      // pads avfoundation's fine-grained timestamps to a constant rate,
      // repeating frames by the thousand.
      ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...captureInput(rect),
        ...(process.platform === 'darwin' ? ['-fps_mode', 'passthrough'] : []), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { stdio: ['pipe', 'pipe', 'pipe'] })
      const size = rect.w * rect.h * 3
      ffmpeg.stdout.on('data', (d) => {
        pending = Buffer.concat([pending, d])
        while (pending.length >= size) {
          onFrame(pending.subarray(0, size))
          pending = pending.subarray(size)
        }
      })
      ffmpeg.stderr.on('data', (d) => { ffmpegErr += d })
      ffmpeg.on('exit', () => {
        if (!goSent) {
          goSent = true
          go() // let the app finish; the result says capture failed
        }
      })
    }

    let lineBuf = ''
    app.stdout.on('data', (d) => {
      lineBuf += d
      let i
      while ((i = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, i)
        lineBuf = lineBuf.slice(i + 1)
        appLog.push(line)
        if (line.startsWith('WF RECT ')) rect = JSON.parse(line.slice(8))
        else if (line === 'WF READY') {
          console.log(`   [${name}] window ${JSON.stringify(rect)}, capturing`)
          startCapture()
        }
        else if (line.startsWith('WF NAV ')) navs++
        else if (line.startsWith('WF NOTE ')) notes.push(line.slice(8))
        else if (line === 'WF END') { ended = true; endedAt = Date.now() }
      }
    })
    app.stderr.on('data', (d) => appLog.push(String(d).trimEnd()))

    // Stop reading and stop ffmpeg — for good: one left capturing would hold
    // the screen and the CPU from the next scenario.
    const stopCapture = () => {
      const proc = ffmpeg
      if (!proc) return
      proc.stdout.removeAllListeners('data')
      proc.stdout.destroy()
      if (proc.exitCode !== null || proc.signalCode !== null) return
      if (process.platform === 'win32') proc.kill()
      else proc.kill('SIGINT')
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      }, 1500).unref()
    }

    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(noFrames)
      clearTimeout(giveUp)
      stopCapture()
      rmSync(goDir, { recursive: true, force: true })
      const duration = ((endedAt || Date.now()) - started) / 1000
      const s = labels.join('')
      const whiteRuns = [...s.matchAll(/[Ww]+/g)].map((m) => m[0].length)
      const count = (c) => s.split(c).length - 1
      // The recording must show the window (its red border) and, before the
      // first navigation, the page in it.
      const pageShown = labels.slice(0, 20).filter((l) => l === 'B').length >= 15
      const verdict = !labels.length || borderless > labels.length * 0.2 || !pageShown
        ? 'NO CAPTURE' : whiteRuns.length ? 'WHITE' : 'clean'
      // Frames between two pages that aren't white: the window behind or
      // anything else.
      const gapRuns = [...s.matchAll(/[R.]+/g)].map((m) => m[0].length)
      mkdirSync(OUT, { recursive: true })
      for (const f of saved) writeFileSync(join(OUT, `${name}-${String(f.index).padStart(4, '0')}-${f.lab}.png`), f.png)
      resolve({
        name, options, verdict, rect, borderless, frames: labels.length, fps: labels.length / (duration || 1), navs,
        whiteRuns, gapRuns, white: count('W') + count('w'), pureWhite: saved.filter((f) => f.lab === 'W' && f.pure > 0.9).length,
        red: count('R'), other: count('.'),
        sequence: s.replace(/B{6,}/g, (m) => `B{${m.length}}`),
        ffmpegErr: ffmpegErr.trim(),
        notes,
        appLog: verdict === 'NO CAPTURE' ? appLog.slice(-30) : [],
      })
    }

    app.on('exit', () => setTimeout(finish, 300))
    const giveUp = setTimeout(() => {
      if (finished) return
      console.log(`   [${name}] no end after 120 s, stopping it`)
      app.kill()
      setTimeout(finish, 3000)
    }, 120_000)
  })
}

const xvfb = startXvfb()
const results = []
for (const name of names.length ? names : Object.keys(scenarios)) {
  console.log(`\n-- ${name}`)
  const r = await runScenario(name, scenarios[name])
  results.push(r)
  console.log(`\n== ${name} ${JSON.stringify(r.options)} view ${JSON.stringify(r.rect)}`)
  console.log(`   ${r.verdict}: ${r.frames} frames at ${r.fps.toFixed(1)} fps, ${r.navs} navigations, ` +
    `${r.whiteRuns.length} white runs ${JSON.stringify(r.whiteRuns)}, ${r.red} frames of the window behind` +
    (r.borderless ? `, ${r.borderless} frames without the window's border` : ''))
  console.log(`   ${r.sequence}`)
  if (r.fps > 200) console.log(`   (${r.fps.toFixed(0)} fps: ffmpeg is repeating frames)`)
  if (r.ffmpegErr) console.log(`   ffmpeg: ${r.ffmpegErr.split('\n').slice(0, 5).join(' | ')}`)
  for (const n of r.notes) console.log(`   ${n}`)
  for (const l of r.appLog) console.log(`   app: ${l}`)
}
xvfb?.kill()

console.log(`\n${'scenario'.padEnd(22)}verdict      white runs / navigations   other gaps   frames   fps`)
for (const r of results) {
  console.log(`${r.name.padEnd(22)}${r.verdict.padEnd(13)}${`${r.whiteRuns.length} / ${r.navs}`.padEnd(27)}` +
    `${String(r.gapRuns.length).padEnd(13)}${String(r.frames).padEnd(9)}${r.fps.toFixed(1)}`)
}
console.log(`\nframes saved to ${OUT}`)
