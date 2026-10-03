import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, writeFileSync } from 'fs'

const PREFIX = '[newbro:main]'
const LOG_FILE = join(app.getPath('userData'), 'newbro.log')
const MAX_LINES = 2000

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) =>
      typeof a === 'string' ? a : typeof a === 'undefined' ? 'undefined' : JSON.stringify(a),
    )
    .join(' ')
}

// Lines logged before startLogSession(): module-import time, before index.ts
// knows whether this process is the primary instance. Null once started.
let pendingLines: string[] | null = []

function writeToFile(level: string, prefix: string, msg: string): void {
  try {
    const line = `${ts()} ${level} ${prefix} ${msg}\n`
    if (pendingLines) pendingLines.push(line)
    else appendFileSync(LOG_FILE, line)
  } catch {
    // ignore file write errors
  }
}

/**
 * Truncate the previous run's log (keeps it manageable) and flush the lines
 * buffered so far. index.ts calls this once the single-instance lock is ours.
 * Truncating at import instead meant every second instance — a link opened
 * from another app, a relaunch from a launcher — wiped the running
 * instance's log on its way to handing over its argv and exiting.
 */
export function startLogSession(): void {
  if (!pendingLines) return
  try {
    writeFileSync(LOG_FILE, `--- Newbro started at ${new Date().toISOString()} ---\n${pendingLines.join('')}`)
  } catch {
    // ignore
  }
  pendingLines = null
}

export function getLogFilePath(): string {
  return LOG_FILE
}

export const log = {
  info: (...args: unknown[]) => {
    console.log(ts(), PREFIX, ...args)
    writeToFile('INFO', PREFIX, formatArgs(args))
  },
  warn: (...args: unknown[]) => {
    console.warn(ts(), PREFIX, ...args)
    writeToFile('WARN', PREFIX, formatArgs(args))
  },
  error: (...args: unknown[]) => {
    console.error(ts(), PREFIX, ...args)
    writeToFile('ERROR', PREFIX, formatArgs(args))
  },
  ipc: (name: string, ...args: unknown[]) => {
    console.log(ts(), PREFIX, `[ipc] ${name}`, ...args)
    writeToFile('INFO', PREFIX, `[ipc] ${name} ${formatArgs(args)}`)
  },
  window: (name: string, ...args: unknown[]) => {
    console.log(ts(), PREFIX, `[window] ${name}`, ...args)
    writeToFile('INFO', PREFIX, `[window] ${name} ${formatArgs(args)}`)
  },
  /** Write a renderer log line to the file (received via IPC) */
  renderer: (level: string, msg: string) => {
    writeToFile(level, '[newbro:renderer]', msg)
  },
}
