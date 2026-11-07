import type { AppSettings, DesignSystem, ThemeId, Tint } from '@shared/types'
import shellwise from './shellwise.tokens.json'
import ferrum from './ferrum.tokens.json'

/**
 * Themes of both design systems. Each theme is a full set of raw --sw-* tokens taken verbatim from
 * its Figma "Theme" collection (shellwise.tokens.json, ferrum.tokens.json: same token names, so
 * tokens.css maps both onto the same semantic names). The design system itself (fonts, radii,
 * sizes, flat vs soft components) is switched by data-ds on :root, see ferrum.css.
 * `scheme` switches the OS-level scheme in main (nativeTheme), which flips prefers-color-scheme
 * and with it the scheme-only tokens (shadows, extra tag hues), then `vars` go inline on :root.
 */
type Tokens = Record<string, string>

export interface Theme {
  id: ThemeId
  ds: DesignSystem
  name: string
  scheme: 'dark' | 'light' | 'system'
  note: string
  /** Three colours for the preview swatch: background, surface, accent. */
  preview: [string, string, string]
  vars: Record<string, string>
}

export const DESIGN_SYSTEMS: { id: DesignSystem; name: string; note: string }[] = [
  { id: 'shellwise', name: 'Shellwise', note: 'мягкая: тёплые фоны, карточки и плитки, скругления, Manrope' },
  { id: 'ferrum', name: 'Ferrum', note: 'строгая: плоско, рамки 1px, таблица хостов, строка состояния, IBM Plex' }
]

const sw = (t: Tokens): Record<string, string> =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [`--sw-${k.replace('/', '-')}`, v]))

const theme = (ds: DesignSystem, id: ThemeId, t: Tokens, name: string, scheme: 'dark' | 'light', note: string): Theme =>
  ({ id, ds, name, scheme, note, preview: [t['bg/app'], t['bg/raised'], t['accent/default']], vars: sw(t) })

const S = shellwise.modes
const F = ferrum.modes

export const THEMES: Theme[] = [
  {
    id: 'system', ds: 'shellwise', name: 'Как в Windows', scheme: 'system', note: 'Oat или Cocoa',
    preview: [S.Oat['bg/app'], S.Cocoa['bg/raised'], S.Oat['accent/default']], vars: {}
  },
  theme('shellwise', 'oat', S.Oat, 'Oat', 'light', 'светлая, тёплая'),
  theme('shellwise', 'mist', S.Mist, 'Mist', 'light', 'светлая, холодная'),
  theme('shellwise', 'cocoa', S.Cocoa, 'Cocoa', 'dark', 'тёмная, тёплая'),
  theme('shellwise', 'midnight', S.Midnight, 'Midnight', 'dark', 'тёмная, синяя'),
  theme('shellwise', 'moss', S.Moss, 'Moss', 'dark', 'тёмная, зелёная'),
  theme('shellwise', 'dusk', S.Dusk, 'Dusk', 'dark', 'тёмная, лиловая'),
  // Ferrum "system" picks Steel or Graphite when applied, see ferrumSystem().
  {
    id: 'system', ds: 'ferrum', name: 'Как в Windows', scheme: 'system', note: 'Steel или Graphite',
    preview: [F.Steel['bg/app'], F.Graphite['bg/raised'], F.Graphite['accent/default']], vars: {}
  },
  theme('ferrum', 'graphite', F.Graphite, 'Graphite', 'dark', 'тёмная, нейтральная'),
  theme('ferrum', 'carbon', F.Carbon, 'Carbon', 'dark', 'чёрная, зелёный «фосфор»'),
  theme('ferrum', 'blueprint', F.Blueprint, 'Blueprint', 'dark', 'тёмно-синяя, циан'),
  theme('ferrum', 'steel', F.Steel, 'Steel', 'light', 'светлая, сталь')
]

/** Themes from before Shellwise may still be saved in settings: show the closest new one. */
const LEGACY: Partial<Record<ThemeId, ThemeId>> = {
  'ios-dark': 'cocoa', 'ios-light': 'oat', termius: 'midnight', nord: 'midnight',
  'solarized-dark': 'moss', 'solarized-light': 'oat', contrast: 'midnight'
}

export const designOf = (settings?: AppSettings): DesignSystem => settings?.design ?? 'shellwise'

export const themesFor = (ds: DesignSystem) => THEMES.filter((t) => t.ds === ds)

/** A theme of the other design system (left over after switching) falls back to "Как в Windows". */
export const themeById = (id: ThemeId | undefined, ds: DesignSystem = 'shellwise') => {
  const real = (id && LEGACY[id]) ?? id
  const list = themesFor(ds)
  return list.find((t) => t.id === real) ?? list[0]
}

const dark = matchMedia('(prefers-color-scheme: dark)')
const ferrumSystem = () => (dark.matches ? F.Graphite : F.Steel)

let applied: string[] = []
let last: AppSettings | undefined

function sendChrome(): void {
  const css = getComputedStyle(document.documentElement)
  window.api.setChrome(css.getPropertyValue('--bg-chrome').trim(), css.getPropertyValue('--label-1').trim(), parseFloat(css.getPropertyValue('--titlebar-h')))
}

// The scheme flips a moment after setTheme(); refresh the title bar and terminals when it lands.
// Ferrum "Как в Windows" carries its colours inline, so it has to be re-applied for the new scheme.
dark.addEventListener('change', () => {
  const t = themeById(last?.theme, designOf(last))
  if (t.ds === 'ferrum' && t.scheme === 'system') return applyTheme(last)
  sendChrome()
  window.dispatchEvent(new Event('themechange'))
})

/** Apply design system + theme + optional accent override + font size to this window and tell main the title bar colours. */
export function applyTheme(settings: AppSettings | undefined): void {
  last = settings
  const ds = designOf(settings)
  const t = themeById(settings?.theme, ds)
  window.api.setTheme(t.scheme)
  const root = document.documentElement
  // Scheme switch in main is async; apply vars on the next frame so computed values are current.
  requestAnimationFrame(() => {
    root.dataset.ds = ds
    applied.forEach((k) => root.style.removeProperty(k))
    const vars: Record<string, string> = ds === 'ferrum' && t.scheme === 'system' ? sw(ferrumSystem()) : { ...t.vars }
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
    if (settings?.termFg) vars['--term-fg'] = vars['--term-cursor'] = settings.termFg
    if (settings?.termBg) vars['--bg-terminal'] = settings.termBg
    if (settings?.mapScale) vars['--map-scale'] = String(settings.mapScale)
    root.dataset.mapNames = settings?.mapFullNames === false ? 'cut' : 'full'
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v))
    applied = Object.keys(vars)
    sendChrome()
    window.dispatchEvent(new Event('themechange'))
    // Terminals measure the mono font once; tell them again when the design system's font has loaded.
    const mono = getComputedStyle(root).getPropertyValue('--font-mono')
    document.fonts.load(`13px ${mono}`).then(() => window.dispatchEvent(new Event('themechange')), () => {})
  })
}
