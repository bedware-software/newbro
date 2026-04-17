// Theme sub-variants. Each family (light/dark) has a set of pre-baked
// variants that differ only by the lightness of the surface colors
// (background / card / muted / border / toolbar etc.). Primary and
// destructive accent colors stay the same across variants so the
// overall palette feel is consistent.
//
// Variant ids are globally unique and namespaced by family so a single
// `data-theme-variant` attribute on <html> is enough for CSS to pick
// the right override block regardless of whether the user picked
// Light, Dark, or System.

export type ThemeFamily = 'light' | 'dark'
export type ThemeChoice = 'light' | 'dark' | 'system'

export interface ThemeVariant {
  id: string
  label: string
}

export const LIGHT_VARIANTS: readonly ThemeVariant[] = [
  { id: 'light-default', label: 'Default' },
  { id: 'light-bright', label: 'Bright' },
  { id: 'light-soft', label: 'Soft' },
] as const

export const DARK_VARIANTS: readonly ThemeVariant[] = [
  { id: 'dark-default', label: 'Default' },
  { id: 'dark-deep', label: 'Deep' },
  { id: 'dark-soft', label: 'Soft' },
] as const

export const DEFAULT_LIGHT_VARIANT = 'light-default'
export const DEFAULT_DARK_VARIANT = 'dark-default'

/** Resolve the OS-preferred family when theme is set to 'system'. */
function systemFamily(): ThemeFamily {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Resolve the effective family the user will see right now. */
export function resolveFamily(theme: ThemeChoice): ThemeFamily {
  return theme === 'system' ? systemFamily() : theme
}

/** Resolve which variant id should be active, given theme + both family preferences. */
export function resolveVariantId(
  theme: ThemeChoice,
  lightVariant: string,
  darkVariant: string,
): string {
  return resolveFamily(theme) === 'light' ? lightVariant : darkVariant
}

/** Sanitize an arbitrary string into a known variant id, falling back to the default. */
export function normalizeLightVariant(id: string | undefined): string {
  return LIGHT_VARIANTS.some((v) => v.id === id) ? (id as string) : DEFAULT_LIGHT_VARIANT
}

export function normalizeDarkVariant(id: string | undefined): string {
  return DARK_VARIANTS.some((v) => v.id === id) ? (id as string) : DEFAULT_DARK_VARIANT
}

// ── Layout density ──
// Controls vertical breathing room between sidebar rows (tabs, groups).
// `compact` is the current/legacy look; `normal` adds gaps roughly the
// size of the toolbar button spacing so rows feel less cramped.

export type Density = 'compact' | 'normal'

export const DENSITIES: readonly { id: Density; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normal', hint: 'Roomy rows with toolbar-style padding.' },
  { id: 'compact', label: 'Compact', hint: 'Tight rows, fits more tabs on screen.' },
] as const

export const DEFAULT_DENSITY: Density = 'normal'

export function normalizeDensity(value: string | undefined): Density {
  return value === 'compact' ? 'compact' : 'normal'
}

export function applyDensity(density: Density): void {
  document.documentElement.setAttribute('data-density', density)
}
