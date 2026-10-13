import type { AppSettings, ThemeId, Tint } from '@shared/types'
import tokens from './shellwise.tokens.json'

/**
 * Shellwise themes. Each one is a full set of raw --sw-* tokens taken verbatim from the Figma
 * "Theme" collection (shellwise.tokens.json); tokens.css maps them onto the semantic names.
 * `scheme` switches the OS-level scheme in main (nativeTheme), which flips prefers-color-scheme
 * and with it the scheme-only tokens (shadows, extra tag hues), then `vars` go inline on :root.
 */
type Mode = keyof typeof tokens.modes

export interface Theme {
  id: ThemeId
  name: string
  scheme: 'dark' | 'light' | 'system'
  note: string
  /** Three colours for the preview swatch: background, surface, accent. */
  preview: [string, string, string]
  vars: Record<string, string>
}

const sw = (mode: Mode): Record<string, string> =>
  Object.fromEntries(Object.entries(tokens.modes[mode]).map(([k, v]) => [`--sw-${k.replace('/', '-')}`, v]))

const theme = (id: ThemeId, mode: Mode, scheme: 'dark' | 'light', note: string): Theme => {
  const t = tokens.modes[mode]
  return { id, name: mode, scheme, note, preview: [t['bg/app'], t['bg/raised'], t['accent/default']], vars: sw(mode) }
}

export const THEMES: Theme[] = [
  {
    id: 'system', name: 'Как в Windows', scheme: 'system', note: 'Oat или Cocoa',
    preview: [tokens.modes.Oat['bg/app'], tokens.modes.Cocoa['bg/raised'], tokens.modes.Oat['accent/default']], vars: {}
  },
  theme('oat', 'Oat', 'light', 'светлая, тёплая'),
  theme('mist', 'Mist', 'light', 'светлая, холодная'),
  theme('cocoa', 'Cocoa', 'dark', 'тёмная, тёплая'),
  theme('midnight', 'Midnight', 'dark', 'тёмная, синяя'),
  theme('moss', 'Moss', 'dark', 'тёмная, зелёная'),
  theme('dusk', 'Dusk', 'dark', 'тёмная, лиловая')
]

/** Themes from before Shellwise may still be saved in settings: show the closest new one. */
const LEGACY: Partial<Record<ThemeId, ThemeId>> = {
  'ios-dark': 'cocoa', 'ios-light': 'oat', termius: 'midnight', nord: 'midnight',
  'solarized-dark': 'moss', 'solarized-light': 'oat', contrast: 'midnight'
}

export const themeById = (id?: ThemeId) => {
  const real = (id && LEGACY[id]) ?? id
  return THEMES.find((t) => t.id === real) ?? THEMES[0]
}

let applied: string[] = []

function sendChrome(): void {
  const css = getComputedStyle(document.documentElement)
  window.api.setChrome(css.getPropertyValue('--bg-chrome').trim(), css.getPropertyValue('--label-1').trim())
}

// The scheme flips a moment after setTheme(); refresh the title bar and terminals when it lands.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  sendChrome()
  window.dispatchEvent(new Event('themechange'))
})

/** Apply theme + optional accent override + font size to this window and tell main the title bar colours. */
export function applyTheme(settings: AppSettings | undefined): void {
  const t = themeById(settings?.theme)
  window.api.setTheme(t.scheme)
  const root = document.documentElement
  // Scheme switch in main is async; apply vars on the next frame so computed values are current.
  requestAnimationFrame(() => {
    applied.forEach((k) => root.style.removeProperty(k))
    const vars: Record<string, string> = { ...t.vars }
    const accent: Tint | undefined = settings?.accent
    if (accent) {
      // A custom accent replaces the theme accent together with its soft and text companions.
      vars['--tint'] = `var(--${accent})`
      vars['--tint-hover'] = `color-mix(in srgb, var(--${accent}) 85%, var(--label-1))`
      vars['--tint-soft'] = `color-mix(in srgb, var(--${accent}) 18%, var(--bg-elevated))`
      vars['--tint-text'] = `var(--${accent})`
      vars['--on-tint'] = 'var(--bg-elevated)'
    }
    if (settings?.termFontSize) vars['--term-font-size'] = String(settings.termFontSize)
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v))
    applied = Object.keys(vars)
    sendChrome()
    window.dispatchEvent(new Event('themechange'))
  })
}
