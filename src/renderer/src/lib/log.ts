const PREFIX = '[newbro]'

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

function sendToFile(level: string, args: unknown[]): void {
  try {
    ;(window as any).electronAPI?.logWrite(level, formatArgs(args))
  } catch {
    // ignore
  }
}

export const log = {
  info: (...args: unknown[]) => {
    console.log(ts(), PREFIX, ...args)
    sendToFile('INFO', args)
  },
  warn: (...args: unknown[]) => {
    console.warn(ts(), PREFIX, ...args)
    sendToFile('WARN', args)
  },
  error: (...args: unknown[]) => {
    console.error(ts(), PREFIX, ...args)
    sendToFile('ERROR', args)
  },
  debug: (...args: unknown[]) => {
    console.debug(ts(), PREFIX, ...args)
    sendToFile('DEBUG', args)
  },
  state: (label: string, data: unknown) => {
    console.log(ts(), PREFIX, `[state] ${label}`, data)
    sendToFile('INFO', [`[state] ${label}`, data])
  },
  action: (name: string, ...args: unknown[]) => {
    console.log(ts(), PREFIX, `[action] ${name}`, ...args)
    sendToFile('INFO', [`[action] ${name}`, ...args])
  },
  event: (name: string, ...args: unknown[]) => {
    console.log(ts(), PREFIX, `[event] ${name}`, ...args)
    sendToFile('INFO', [`[event] ${name}`, ...args])
  },
  ipc: (name: string, ...args: unknown[]) => {
    console.log(ts(), PREFIX, `[ipc] ${name}`, ...args)
    sendToFile('INFO', [`[ipc] ${name}`, ...args])
  },
}
