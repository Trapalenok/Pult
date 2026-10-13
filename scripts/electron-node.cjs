// Runs a script with Electron's bundled Node (BoringSSL), cross-platform: node scripts/electron-node.cjs <file>
const { spawnSync } = require('child_process')
const electron = require('electron')
const r = spawnSync(electron, ['--no-warnings', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(r.status ?? 1)
