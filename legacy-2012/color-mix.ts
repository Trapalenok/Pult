/**
 * Pult Legacy (Electron 22 = Chromium 108) has no CSS color-mix(), it came in Chromium 111.
 * Every color-mix(in srgb, A P%, B) of the renderer becomes var(--cm__A__P__B) at build time, and
 * color-mix-shim.ts computes those variables on :root from the current theme. A and B are root
 * variables or plain colours; var(--c) (set by the .tint-* classes) goes through --cmc__P__B, which the
 * shim points at the matching --cm__<tint>__P__B in each .tint-* class.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Plugin } from 'vite'

export interface Mix {
  name: string
  a: string
  p: number
  b: string
}

const MIX = /color-mix\(in srgb,\s*(var\(--[\w-]+\)|var\(--\$\{\w+\}\)|#[0-9a-f]{3,8}|[a-z]+)\s+(\d+(?:\.\d+)?)%,\s*(var\(--[\w-]+\)|#[0-9a-f]{3,8}|[a-z]+)\s*\)/gi

function token(arg: string): string {
  const v = /^var\(--([\w-]+)\)$/.exec(arg)
  if (v) return v[1]
  if (/^#[0-9a-f]{3,8}$/i.test(arg)) return 'h' + arg.slice(1).toLowerCase()
  if (/^[a-z]+$/i.test(arg)) return arg.toLowerCase()
  throw new Error(`color-mix: не умею разобрать аргумент ${arg}`)
}

const mixName = (a: string, p: string, b: string) => `--cm__${token(a)}__${p.replace('.', '_')}__${token(b)}`
const tintName = (p: string, b: string) => `--cmc__${p.replace('.', '_')}__${token(b)}`

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.(css|ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []
  )
}

/** .tint-blue { --c: var(--blue); } → ['blue', 'blue'] */
function scanTints(sources: string[]): [string, string][] {
  const out: [string, string][] = []
  for (const s of sources) for (const m of s.matchAll(/\.tint-(\w+)\s*\{\s*--c:\s*var\(--([\w-]+)\)/g)) out.push([m[1], m[2]])
  return out
}

export function colorMixPlugin(rendererSrc: string, shim: string): Plugin {
  const sources = files(rendererSrc).map((f) => readFileSync(f, 'utf8'))
  const tints = scanTints(sources)
  const mixes = new Map<string, Mix>()
  const tintMixes = new Map<string, { p: number; b: string }>()
  const add = (a: string, p: string, b: string) => mixes.set(mixName(a, p, b), { name: mixName(a, p, b), a, p: +p, b })

  // Every mix is known before the first file is bundled, so the shim's list is complete.
  for (const s of sources) {
    for (const [, a, p, b] of s.matchAll(MIX)) {
      if (a === 'var(--c)') {
        tintMixes.set(tintName(p, b), { p: +p, b })
        for (const [, v] of tints) add(`var(--${v})`, p, b)
      } else if (a.includes('${')) {
        for (const [, v] of tints) add(`var(--${v})`, p, b)
      } else add(a, p, b)
    }
  }

  const rewrite = (code: string) =>
    code.replace(MIX, (_all, a: string, p: string, b: string) => {
      if (a === 'var(--c)') return `var(${tintName(p, b)})`
      // themes.ts: `color-mix(in srgb, var(--${accent}) 85%, …)` inside a template literal.
      const dyn = /^var\(--\$\{(\w+)\}\)$/.exec(a)
      if (dyn) return `var(--cm__\${${dyn[1]}}__${p.replace('.', '_')}__${token(b)})`
      return `var(${mixName(a, p, b)})`
    })

  const VIRTUAL = 'virtual:pult-color-mix'
  return {
    name: 'pult-color-mix',
    enforce: 'pre',
    resolveId: (id) => (id === VIRTUAL ? '\0' + VIRTUAL : undefined),
    load(id) {
      if (id !== '\0' + VIRTUAL) return undefined
      const tintRules = tints.map(([cls, v]) => ({
        cls,
        vars: [...tintMixes].map(([name, m]) => [name, mixName(`var(--${v})`, String(m.p), m.b)])
      }))
      return `export const mixes = ${JSON.stringify([...mixes.values()])}\nexport const tintRules = ${JSON.stringify(tintRules)}`
    },
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file.replace(/\\/g, '/').startsWith(rendererSrc.replace(/\\/g, '/')) || !/\.(css|ts|tsx)$/.test(file)) return undefined
      let out = code.includes('color-mix(') ? rewrite(code) : code
      if (/[\\/]src[\\/]main\.tsx$/.test(file)) out = `import ${JSON.stringify(shim.replace(/\\/g, '/'))}\n` + out
      if (out.includes('color-mix(')) this.error(`color-mix остался в ${file}: шаблон не распознан`)
      return out === code ? undefined : { code: out, map: null }
    }
  }
}
