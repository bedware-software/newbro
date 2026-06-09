// Shared permission vocabulary for the renderer (prompt infobar + settings).
// Mirrors the canonical types in src/main/permissions-store.ts; kept as a
// separate renderer copy so we don't import across the main/renderer boundary.

export type PermissionKind =
  | 'microphone'
  | 'camera'
  | 'geolocation'
  | 'notifications'
  | 'clipboard'
  | 'midi'

export type PermissionPolicy = 'ask' | 'allow' | 'block'
export type PermissionDecision = 'allow' | 'block'

export interface PermissionGrant {
  partition: string
  origin: string
  kind: PermissionKind
  decision: PermissionDecision
  updatedAt: number
}

export const PERMISSION_KINDS: PermissionKind[] = [
  'microphone',
  'camera',
  'geolocation',
  'notifications',
  'clipboard',
  'midi',
]

/** Title-case label for settings rows and exception entries. */
export const PERMISSION_LABEL: Record<PermissionKind, string> = {
  microphone: 'Microphone',
  camera: 'Camera',
  geolocation: 'Location',
  notifications: 'Notifications',
  clipboard: 'Clipboard',
  midi: 'MIDI devices',
}

/** Verb phrase used in the prompt: "{site} wants to {phrase}". */
const PERMISSION_PHRASE: Record<PermissionKind, string> = {
  microphone: 'use your microphone',
  camera: 'use your camera',
  geolocation: 'know your location',
  notifications: 'show notifications',
  clipboard: 'see text and images copied to the clipboard',
  midi: 'use your MIDI devices',
}

/** Join the requested kinds into a single human phrase, e.g.
 *  "use your microphone and use your camera". */
export function describePermissionKinds(kinds: PermissionKind[]): string {
  const phrases = kinds.map((k) => PERMISSION_PHRASE[k] ?? k)
  if (phrases.length <= 1) return phrases[0] ?? ''
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}
