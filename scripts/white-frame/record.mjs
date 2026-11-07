#!/usr/bin/env node
// Records the screen while scripts/white-frame/app.cjs goes back and forth
// between two black pages on different sites, and labels every frame of the
// page's area:
//   B  black — a page
//   W  white (r, g and b all >= 250) over 90% of it — the blank white frame
//   w  white over 2–90% of it
//   R  the window's dark red, through a see-through view
//   .  anything else
//
//   node scripts/white-frame/record.mjs [scenario ...] [--fps=60] [--out=dir]
//
// Runs every scenario (see SCENARIOS) unless some are named. Needs ffmpeg on
// PATH. Linux: an X display — it starts Xvfb on :99 when DISPLAY is unset;
// macOS: Screen Recording permission for the terminal; Windows: nothing more.
// Frames it labels W, plus a black and a red one, are saved as PNGs under
// out/white-frame/<platform>/ (or --out).

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
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

const args = process.argv.slice(2)
const flag = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : def
}
const FPS = Number(flag('fps', 60))
const OUT = flag('out', join(here, '../../out/white-frame', process.platform))
const names = args.filter((a) => !a.startsWith('--'))
for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}`)

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
function label(frame, w, h) {
  const m = Math.min(8, Math.floor(Math.min(w, h) / 10))
  let n = 0, white = 0, pure = 0, black = 0, red = 0
  for (let y = m; y < h - m; y += 4) {
    for (let x = m, i = (y * w + m) * 3; x < w - m; x += 4, i += 12) {
      const r = frame[i], g = frame[i + 1], b = frame[i + 2]
      n++
      if (r >= 250 && g >= 250 && b >= 250) { white++; if (r === 255 && g === 255 && b === 255) pure++ }
      else if (r <= 12 && g <= 12 && b <= 12) black++
      else if (r >= 0x28 && r <= 0x60 && g <= 0x18 && b <= 0x18) red++
    }
  }
  const lab = white / n >= 0.9 ? 'W' : white / n >= 0.02 ? 'w' : black / n >= 0.9 ? 'B' : red / n >= 0.9 ? 'R' : '.'
  return { lab, pure: pure / n }
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
    const list = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' })
    const m = /\[(\d+)\] Capture screen 0/.exec(list.stderr)
    if (!m) throw new Error(`no screen among avfoundation devices:\n${list.stderr}`)
    macScreen = m[1]
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
    const app = spawn(electronPath, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), join(here, 'app.cjs')], {
      env: { ...process.env, WF_OPTIONS: JSON.stringify(options), ELECTRON_ENABLE_LOGGING: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
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

    const onFrame = (frame) => {
      const { lab, pure } = label(frame, rect.w, rect.h)
      labels.push(lab)
      if (!started) started = Date.now()
      if (!goSent && labels.length >= 20) {
        goSent = true
        app.stdin.write('GO\n')
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
          app.stdin.write('GO\n')
        }
      }, 20_000)
      ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...captureInput(rect), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
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
          app.stdin.write('GO\n') // let the app finish; the result says capture failed
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
        else if (line === 'WF READY') startCapture()
        else if (line.startsWith('WF NAV ')) navs++
      }
    })
    app.stderr.on('data', (d) => appLog.push(String(d).trimEnd()))

    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(noFrames)
      clearTimeout(giveUp)
      const duration = (Date.now() - started) / 1000
      const s = labels.join('')
      const whiteRuns = [...s.matchAll(/[Ww]+/g)].map((m) => m[0].length)
      const count = (c) => s.split(c).length - 1
      const black = count('B')
      const verdict = !labels.length || black < labels.length * 0.5 ? 'NO CAPTURE' : whiteRuns.length ? 'WHITE' : 'clean'
      mkdirSync(OUT, { recursive: true })
      for (const f of saved) writeFileSync(join(OUT, `${name}-${String(f.index).padStart(4, '0')}-${f.lab}.png`), f.png)
      resolve({
        name, options, verdict, rect, frames: labels.length, fps: labels.length / (duration || 1), navs,
        whiteRuns, white: count('W') + count('w'), pureWhite: saved.filter((f) => f.lab === 'W' && f.pure > 0.9).length,
        red: count('R'), other: count('.'),
        sequence: s.replace(/B{6,}/g, (m) => `B{${m.length}}`),
        ffmpegErr: ffmpegErr.trim(),
        appLog: verdict === 'NO CAPTURE' ? appLog.slice(-30) : [],
      })
    }

    app.on('exit', () => {
      setTimeout(() => {
        if (ffmpeg && ffmpeg.exitCode === null) {
          ffmpeg.on('exit', finish)
          if (process.platform === 'win32') ffmpeg.kill()
          else ffmpeg.kill('SIGINT')
          setTimeout(finish, 3000)
        } else finish()
      }, 300)
    })
    const giveUp = setTimeout(() => { if (!finished) app.kill() }, 120_000)
  })
}

const xvfb = startXvfb()
const results = []
for (const name of names.length ? names : Object.keys(SCENARIOS)) {
  const r = await runScenario(name, SCENARIOS[name])
  results.push(r)
  console.log(`\n== ${name} ${JSON.stringify(r.options)} view ${JSON.stringify(r.rect)}`)
  console.log(`   ${r.verdict}: ${r.frames} frames at ${r.fps.toFixed(1)} fps, ${r.navs} navigations, ` +
    `${r.whiteRuns.length} white runs ${JSON.stringify(r.whiteRuns)}, ${r.red} frames of the window behind`)
  console.log(`   ${r.sequence}`)
  if (r.ffmpegErr) console.log(`   ffmpeg: ${r.ffmpegErr.split('\n').slice(0, 5).join(' | ')}`)
  for (const l of r.appLog) console.log(`   app: ${l}`)
}
xvfb?.kill()

console.log(`\n${'scenario'.padEnd(22)}verdict      white runs / navigations   frames   fps`)
for (const r of results) {
  console.log(`${r.name.padEnd(22)}${r.verdict.padEnd(13)}${`${r.whiteRuns.length} / ${r.navs}`.padEnd(27)}${String(r.frames).padEnd(9)}${r.fps.toFixed(1)}`)
}
console.log(`\nframes saved to ${OUT}`)
