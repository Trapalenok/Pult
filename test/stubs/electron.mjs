// Just enough of Electron for the updater test: net.fetch goes to whatever the test puts in globalThis.__fetch.
import { tmpdir } from 'os'

export const app = {
  getVersion: () => globalThis.__version ?? '0.3.2',
  getPath: () => globalThis.__temp ?? tmpdir(),
  isPackaged: true,
  quit: () => (globalThis.__quit = true)
}
export const net = { fetch: (url, init) => globalThis.__fetch(url, init) }
export const shell = { openPath: async () => '' }
