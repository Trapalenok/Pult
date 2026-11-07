#!/usr/bin/env node
/**
 * Pult Legacy for Windows 7 / 8.1 / Server 2012 R2: the same sources built on Electron 22 in its own folder
 * .build-2012, so the main Pult and its node_modules stay as they are.
 *
 *   npm run dist:legacy              installer + portable into dist\
 *   npm run dist:legacy -- --dir     unpacked app only (quick check)
 *
 * Extra arguments go to electron-builder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'fs'
import { basename, join, relative, resolve } from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stage = join(root, '.build-2012')
const edition = JSON.parse(readFileSync(join(root, 'legacy-2012', 'edition.json'), 'utf8'))

function run(cmd, args) {
  console.log(`\n> ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

// Fresh sources every time; node_modules stays between builds.
mkdirSync(stage, { recursive: true })
for (const p of ['src', 'build', 'legacy-2012', 'out', 'dist']) rmSync(join(stage, p), { recursive: true, force: true })
for (const p of ['src', 'build', 'legacy-2012']) cpSync(join(root, p), join(stage, p), { recursive: true })
for (const f of ['tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'package-lock.json', 'LICENSE']) copyFileSync(join(root, f), join(stage, f))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
pkg.scripts = {}
pkg.devDependencies.electron = edition.electron
pkg.description = `${pkg.description} (Windows 7, 8.1, Server 2012 R2)`
pkg.build = {
  ...pkg.build,
  appId: edition.appId,
  productName: edition.productName,
  nsis: { ...pkg.build.nsis, artifactName: `${edition.artifactPrefix}-Setup-\${version}.exe` },
  portable: { ...pkg.build.portable, artifactName: `${edition.artifactPrefix}-\${version}-portable.exe` }
}
writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

// The root lock pins everything; npm only swaps Electron for 22.
run('npm', ['install', '--no-audit', '--no-fund'])
run('npx', ['electron-vite', 'build', '--config', 'legacy-2012/electron.vite.config.ts'])
const extra = process.argv.slice(2)
// A locally recovered Electron folder can still contain the previous edition's renamed executable
// alongside electron.exe. Pass a clean copy to electron-builder so the new edition does not bundle
// the stale Pult 2012.exe as a second full-size application binary.
const electronDistIndex = extra.findIndex((arg) => arg.startsWith('--config.electronDist='))
if (electronDistIndex !== -1) {
  const provided = extra[electronDistIndex].slice('--config.electronDist='.length)
  const source = resolve(stage, provided)
  if (existsSync(source) && !source.endsWith('.zip') && !source.endsWith('.7z')) {
    const clean = join(stage, '.electron-dist-clean')
    rmSync(clean, { recursive: true, force: true })
    cpSync(source, clean, {
      recursive: true,
      filter: (path) => {
        const name = basename(path).toLowerCase()
        const rel = relative(source, path)
        return !(rel && !rel.includes('\\') && !rel.includes('/') && name.endsWith('.exe') && name !== 'electron.exe')
      }
    })
    extra[electronDistIndex] = '--config.electronDist=.electron-dist-clean'
  }
}
run('npx', ['electron-builder', ...(extra.length ? extra : ['--win', '--x64'])])

const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
for (const f of existsSync(join(stage, 'dist')) ? readdirSync(join(stage, 'dist')) : []) {
  if (f.startsWith(edition.artifactPrefix) && f.endsWith('.exe')) {
    copyFileSync(join(stage, 'dist', f), join(dist, f))
    console.log(`dist\\${f}`)
  }
}
