// Builds the native helpers main spawns (macOS only; a no-op elsewhere).
//
//   native/newbro-hybrid.swift → out/native/newbro-hybrid
//
// A universal binary, so an x64 build made on Apple silicon still runs. It is
// rebuilt only when the source is newer. electron-builder unpacks it from the
// asar (build.asarUnpack in package.json) so it can be executed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native/newbro-hybrid.swift')
const output = join(root, 'out/native/newbro-hybrid')

if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0)

mkdirSync(dirname(output), { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'newbro-native-'))
try {
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const slice = join(work, arch)
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos13`, source, '-o', slice], { stdio: 'inherit' })
    return slice
  })
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', output], { stdio: 'inherit' })
  console.log(`built ${output}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
