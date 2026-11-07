/**
 * Pult Legacy: the same sources on Electron 22 (Chromium 108, Node 16), the last Electron that runs on
 * Windows 7, 8.1 and Server 2012 / 2012 R2. Built by scripts/build-2012.mjs, never by `npm run build`.
 */
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { colorMixPlugin } from './color-mix'
import edition from './edition.json'

const alias = { '@shared': resolve('src/shared') }

/** Its own Windows app id, so the Start menu shortcut and notifications are Pult Legacy's, not Pult's. */
function appIdPlugin(): Plugin {
  const from = "app.setAppUserModelId('local.sshclient')"
  return {
    name: 'pult-2012-app-id',
    enforce: 'pre',
    transform(code, id) {
      if (!/src[\\/]main[\\/]index\.ts$/.test(id)) return undefined
      if (!code.includes(from)) this.error(`Pult Legacy: в src/main/index.ts нет ${from}`)
      return { code: code.replace(from, `app.setAppUserModelId('${edition.appId}')`), map: null }
    }
  }
}

/**
 * Node 16 in Electron 22 resolves import() through its ESM loader, which can't read packages inside app.asar
 * ("Cannot find package 'ssh2'"). require() can, so dynamic imports of packages become require().
 */
function requirePlugin(): Plugin {
  return {
    name: 'pult-2012-require',
    enforce: 'pre',
    transform(code, id) {
      if (!/src[\\/]main[\\/]/.test(id) || !/\bimport\(\s*'[^'.]/.test(code)) return undefined
      return { code: code.replace(/\bimport\(\s*'([^'.][^']*)'\s*\)/g, "Promise.resolve().then(() => require('$1'))"), map: null }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), appIdPlugin(), requirePlugin()],
    resolve: { alias },
    build: { target: 'node16.17' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { target: 'node16.17' }
  },
  renderer: {
    resolve: { alias },
    plugins: [colorMixPlugin(resolve('src/renderer/src'), resolve('legacy-2012/color-mix-shim.ts')), react()],
    build: { target: 'chrome108' }
  }
})
