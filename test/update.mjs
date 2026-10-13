// Update check and download against a fake GitHub: npm run test:update. LIVE=1 also asks the real one.
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareVersions, pickAsset, releasesBetween } from '../src/shared/update.ts'
import { Updater } from '../src/main/update/updater.ts'

let failed = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

eq('0.3.10 > 0.3.9', compareVersions('0.3.10', '0.3.9'), 1)
eq('v0.3.2 = 0.3.2', compareVersions('v0.3.2', '0.3.2'), 0)
eq('0.4 > 0.3.9', compareVersions('0.4', '0.3.9'), 1)
eq('1.0.0-beta = 1.0.0', compareVersions('1.0.0-beta', '1.0.0'), 0)
const assets = [{ name: 'Pult-0.3.3-portable.exe' }, { name: 'Pult-Setup-0.3.3.exe' }, { name: 'latest.yml' }]
eq('setup asset', pickAsset(assets, 'setup')?.name, 'Pult-Setup-0.3.3.exe')
eq('portable asset', pickAsset(assets, 'portable')?.name, 'Pult-0.3.3-portable.exe')

// Fake GitHub: 0.3.1, 0.3.2 (current), 0.3.3, a draft 0.4.0 and a prerelease.
const blob = Buffer.alloc(300_000, 7)
const sha = createHash('sha256').update(blob).digest('hex')
const rel = (v, extra = {}) => ({
  tag_name: `v${v}`,
  name: `Pult v${v}`,
  body: `Pult ${v}.\n\n**Что скачать**\n- setup\n\n**Что нового в ${v}**\n- пункт ${v}\n\nБаза не трогается.`,
  draft: false,
  prerelease: false,
  published_at: '2026-10-13T12:00:00Z',
  assets: [
    { name: `Pult-Setup-${v}.exe`, browser_download_url: `https://github.com/Trapalenok/Pult/releases/download/v${v}/Pult-Setup-${v}.exe`, size: blob.length, digest: `sha256:${sha}` },
    { name: `Pult-${v}-portable.exe`, browser_download_url: `https://github.com/Trapalenok/Pult/releases/download/v${v}/Pult-${v}-portable.exe`, size: blob.length, digest: v === '0.3.1' ? 'sha256:00' : null }
  ],
  ...extra
})
const releases = [rel('0.3.1'), rel('0.4.0', { draft: true }), rel('0.3.3'), rel('0.5.0-rc1', { prerelease: true }), rel('0.3.2')]
let calls = []
globalThis.__fetch = async (url) => {
  calls.push(url)
  if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(releases), { status: 200 })
  if (url.includes('/releases/download/')) return new Response(blob, { status: 200, headers: { 'content-length': String(blob.length) } })
  return new Response('nope', { status: 404 })
}
globalThis.__temp = mkdtempSync(join(tmpdir(), 'pult-upd-'))
const portableDir = mkdtempSync(join(tmpdir(), 'pult-portable-'))
process.env.PORTABLE_EXECUTABLE_FILE = join(portableDir, 'Pult-0.3.2-portable.exe')
process.env.PORTABLE_EXECUTABLE_DIR = portableDir

const states = []
const u = new Updater((s) => states.push(s.phase))
let s = await u.check()
eq('kind', s.kind, 'portable')
eq('versions, newest first, no draft/prerelease', s.releases.map((r) => r.version), ['0.3.3', '0.3.2', '0.3.1'])
eq('available', s.available, '0.3.3')
eq('portable asset picked', s.releases[0].asset?.name, 'Pult-0.3.3-portable.exe')
eq('what an update to 0.3.3 brings', releasesBetween(s.releases, '0.3.2', '0.3.3').map((r) => r.version), ['0.3.3'])

s = await u.download('0.3.3')
eq('downloaded', [s.phase, s.ready, s.progress], ['downloaded', '0.3.3', 1])
eq('file in temp', readFileSync(join(globalThis.__temp, 'pult-update', 'Pult-0.3.3-portable.exe')).length, blob.length)

// Older version with a wrong checksum: refused, nothing left behind, state says why.
s = await u.download('0.3.1')
eq('bad checksum refused', s.phase, 'error')
eq('bad checksum message', /Контрольная сумма/.test(s.error ?? ''), true)
eq('bad file removed', existsSync(join(globalThis.__temp, 'pult-update', 'Pult-0.3.1-portable.exe.part')), false)

// Back to 0.3.3 and install: the new portable exe lands next to the running one.
await u.download('0.3.3')
// Starting it fails here (not a real exe), but the copy happens first and the failure is reported.
await u.install()
eq('new portable copied next to the old one', existsSync(join(portableDir, 'Pult-0.3.3-portable.exe')), true)
eq('failed start is reported, Pult stays open', [u.get().phase, globalThis.__quit], ['error', undefined])

// No network at start: silent check stays quiet.
globalThis.__fetch = async () => { throw new Error('ENOTFOUND') }
const quiet = new Updater(() => {})
s = await quiet.check(true)
eq('silent offline check', [s.phase, s.error], ['idle', undefined])
s = await quiet.check(false)
eq('manual offline check explains', [s.phase, /Не удалось проверить/.test(s.error ?? '')], ['error', true])

if (process.env.LIVE) {
  globalThis.__fetch = (url, init) => fetch(url, init)
  const live = await new Updater(() => {}).check()
  console.log('live releases:', live.releases.map((r) => `${r.version}${r.asset ? '' : ' (no asset)'}`).join(', '), live.error ?? '')
  // A shared IP may be over GitHub's anonymous limit; then the message must say so.
  eq('live check: releases or a clear error', live.releases.length > 0 || /GitHub/.test(live.error ?? ''), true)
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
