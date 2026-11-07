/**
 * Pult Legacy: computes the --cm__* variables that stand in for color-mix() (see color-mix.ts) on :root,
 * the way Chromium 111+ would mix them: srgb, premultiplied alpha. Recomputed whenever the theme can
 * change: inline vars or attributes on <html>, the light/dark scheme, the app's themechange event.
 */
// @ts-expect-error virtual module from color-mix.ts
import { mixes, tintRules } from 'virtual:pult-color-mix'

interface Mix {
  name: string
  a: string
  p: number
  b: string
}
type Rgba = [number, number, number, number]

const root = document.documentElement
const ctx = document.createElement('canvas').getContext('2d')!

function parse(color: string): Rgba | undefined {
  // An invalid colour leaves fillStyle as it was: two different starting values tell it apart.
  ctx.fillStyle = '#000'
  ctx.fillStyle = color
  const s = String(ctx.fillStyle)
  ctx.fillStyle = '#fff'
  ctx.fillStyle = color
  if (String(ctx.fillStyle) !== s) return undefined
  if (s.startsWith('#')) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1]
  const m = /rgba?\(([^)]+)\)/.exec(s)
  if (!m) return undefined
  const [r, g, b, a = 1] = m[1].split(',').map(Number)
  return [r, g, b, a]
}

function mix(x: Rgba, y: Rgba, p: number): string {
  const p1 = p / 100
  const p2 = 1 - p1
  const a = x[3] * p1 + y[3] * p2
  if (a <= 0) return 'rgba(0, 0, 0, 0)'
  const c = (i: number) => Math.round((x[i] * x[3] * p1 + y[i] * y[3] * p2) / a)
  return `rgba(${c(0)}, ${c(1)}, ${c(2)}, ${+a.toFixed(4)})`
}

function compute(): void {
  const css = getComputedStyle(root)
  const value = (arg: string) => (arg.startsWith('var(') ? css.getPropertyValue(arg.slice(4, -1)).trim() : arg)
  // Mixes can feed each other (--tint-soft is one), so a few passes until nothing changes.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false
    for (const m of mixes as Mix[]) {
      const a = value(m.a)
      const b = value(m.b)
      const x = a ? parse(a) : undefined
      const y = b ? parse(b) : undefined
      if (!x || !y) continue
      const v = mix(x, y, m.p)
      if (root.style.getPropertyValue(m.name) !== v) {
        root.style.setProperty(m.name, v)
        changed = true
      }
    }
    if (!changed) break
  }
}

const style = document.createElement('style')
style.textContent = (tintRules as { cls: string; vars: [string, string][] }[])
  .map((t) => `.tint-${t.cls} { ${t.vars.map(([k, v]) => `${k}: var(${v});`).join(' ')} }`)
  .join('\n')
document.head.appendChild(style)

compute()
// Registered before any other module listens, so terminals read the new values on themechange.
window.addEventListener('themechange', compute)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', compute)
new MutationObserver(compute).observe(root, { attributes: true })
