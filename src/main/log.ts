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

function writeToFile(level: string, prefix: string, msg: string): void {
  try {
    const line = `${ts()} ${level} ${prefix} ${msg}\n`
    appendFileSync(LOG_FILE, line)
  } catch {
    // ignore file write errors
  }
}

// Truncate log file on startup to keep it manageable
try {
  writeFileSync(LOG_FILE, `--- Newbro started at ${new Date().toISOString()} ---\n`)
} catch {
  // ignore
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
