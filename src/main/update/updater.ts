import { app, net, shell } from 'electron'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { compareVersions, pickAsset, UPDATE_REPO, type InstallKind, type ReleaseAsset, type ReleaseInfo, type UpdateState } from '@shared/update'

/**
 * Checks GitHub Releases of the public repo, downloads the setup (or portable) exe of the chosen
 * version and runs it. No token: the repo is public, and the anonymous API limit (60 requests an
 * hour per IP) is far more than a check at start and by hand need.
 */

interface GhAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

interface GhRelease {
  tag_name: string
  name: string | null
  body: string | null
  draft: boolean
  prerelease: boolean
  published_at: string | null
  assets: GhAsset[]
}

const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPO}/releases/download/`

function installKind(): InstallKind {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable'
  return app.isPackaged && process.platform === 'win32' ? 'setup' : 'dev'
}

export class Updater {
  private state: UpdateState
  private file: string | null = null
  private abort: AbortController | null = null

  constructor(private emit: (s: UpdateState) => void) {
    // On Linux and in dev runs nothing can be installed, but the check still shows what's new.
    this.state = { current: app.getVersion(), kind: installKind(), phase: 'idle', releases: [] }
  }

  get(): UpdateState {
    return this.state
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.emit(this.state)
  }

  /** silent: the check at start; when there's no network it just stays quiet. */
  async check(silent = false): Promise<UpdateState> {
    if (this.state.phase === 'checking' || this.state.phase === 'downloading' || this.state.phase === 'installing') return this.state
    const prev = this.state.phase
    this.set({ phase: 'checking', error: undefined })
    try {
      const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Pult/${this.state.current}` },
        signal: AbortSignal.timeout(20_000)
      })
      if (res.status === 403 || res.status === 429) throw new Error('GitHub временно ограничил число запросов с этого адреса. Попробуйте через час.')
      if (!res.ok) throw new Error(`GitHub ответил ${res.status} ${res.statusText}`)
      const releases = ((await res.json()) as GhRelease[])
        .filter((r) => !r.draft && !r.prerelease && /^v?\d+\.\d+/.test(r.tag_name))
        .map((r) => this.toRelease(r))
        .sort((a, b) => compareVersions(b.version, a.version))
      const newest = releases[0]
      this.set({
        phase: prev === 'downloaded' ? 'downloaded' : 'idle',
        releases,
        available: newest && compareVersions(newest.version, this.state.current) > 0 ? newest.version : undefined,
        checkedAt: new Date().toISOString()
      })
    } catch (e) {
      const offline = !silent ? `Не удалось проверить обновления: ${message(e)}` : undefined
      this.set({ phase: prev === 'downloaded' ? 'downloaded' : offline ? 'error' : 'idle', error: offline })
    }
    return this.state
  }

  private toRelease(r: GhRelease): ReleaseInfo {
    const a = pickAsset(r.assets, this.state.kind === 'portable' ? 'portable' : 'setup')
    const asset: ReleaseAsset | undefined =
      a && a.browser_download_url.startsWith(DOWNLOAD_PREFIX)
        ? { name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest ?? undefined }
        : undefined
    return {
      version: r.tag_name.replace(/^v/i, ''),
      tag: r.tag_name,
      name: r.name || r.tag_name,
      notes: r.body ?? '',
      publishedAt: r.published_at ?? '',
      asset
    }
  }

  /** Downloads the exe of `version` (newer or older) into the temp folder and checks its size and SHA-256. */
  async download(version: string): Promise<UpdateState> {
    if (this.state.kind === 'dev') throw new Error('Pult запущен из исходников: обновляйте через git pull.')
    if (this.state.phase === 'downloading' || this.state.phase === 'installing') return this.state
    const rel = this.state.releases.find((r) => r.version === version)
    if (!rel?.asset) throw new Error(`В релизе ${version} нет файла ${this.state.kind === 'portable' ? 'portable-версии' : 'установщика'}.`)
    const asset = rel.asset

    const dir = join(app.getPath('temp'), 'pult-update')
    mkdirSync(dir, { recursive: true })
    // Only one download is kept: whatever an earlier one left goes.
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
    const target = join(dir, asset.name)
    const part = `${target}.part`

    this.abort = new AbortController()
    this.file = null
    this.set({ phase: 'downloading', progress: 0, ready: undefined, error: undefined })
    try {
      const res = await net.fetch(asset.url, { headers: { 'User-Agent': `Pult/${this.state.current}` }, signal: this.abort.signal })
      if (!res.ok || !res.body) throw new Error(`GitHub ответил ${res.status} ${res.statusText}`)
      const total = Number(res.headers.get('content-length')) || asset.size
      const hash = createHash('sha256')
      const out = createWriteStream(part)
      const reader = res.body.getReader()
      let got = 0
      let shown = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          hash.update(value)
          got += value.length
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
          if (total && got - shown > total / 200) (shown = got), this.set({ progress: got / total })
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      }
      if (asset.size && got !== asset.size) throw new Error(`Файл скачался не целиком: ${got} из ${asset.size} байт.`)
      const sha = hash.digest('hex')
      if (asset.digest?.startsWith('sha256:') && asset.digest.slice(7).toLowerCase() !== sha) {
        throw new Error('Контрольная сумма скачанного файла не совпала с указанной на GitHub. Файл удалён.')
      }
      renameSync(part, target)
      this.file = target
      this.set({ phase: 'downloaded', progress: 1, ready: version })
    } catch (e) {
      rmSync(part, { force: true })
      const cancelled = this.abort?.signal.aborted
      this.set({ phase: cancelled ? 'idle' : 'error', progress: undefined, error: cancelled ? undefined : `Не удалось скачать ${version}: ${message(e)}` })
    } finally {
      this.abort = null
    }
    return this.state
  }

  cancel(): void {
    this.abort?.abort()
  }

  /**
   * Closes Pult and runs the downloaded file. Setup: silent install over the current one, into
   * the same folder, then Pult starts again by itself. Portable: the new exe is put next to the
   * running one and started. The base in %APPDATA%\ssh-client is not touched either way.
   */
  async install(): Promise<void> {
    const file = this.file
    if (this.state.phase !== 'downloaded' || !file || !existsSync(file)) throw new Error('Сначала скачайте обновление.')
    this.set({ phase: 'installing' })
    try {
      if (this.state.kind === 'portable') {
        const dir = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.env.PORTABLE_EXECUTABLE_FILE!)
        const next = join(dir, this.state.releases.find((r) => r.version === this.state.ready)?.asset?.name ?? 'Pult-portable.exe')
        if (next !== process.env.PORTABLE_EXECUTABLE_FILE) copyFileSync(file, next)
        await start(next, [])
      } else if (/program files/i.test(process.execPath)) {
        // Installed for all users: it needs the administrator prompt, so the installer runs with its own window.
        const err = await shell.openPath(file)
        if (err) throw new Error(err)
      } else {
        // electron-builder's installer: /S silent, --updated as from an updater, --force-run starts Pult after it.
        await start(file, ['/S', '--updated', '--force-run'])
      }
    } catch (e) {
      this.set({ phase: 'error', error: `Не удалось запустить установку: ${message(e)}` })
      return
    }
    setTimeout(() => app.quit(), 300)
  }
}

/** Starts a detached process; resolves once Windows has actually started it. */
function start(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => (child.unref(), resolve()))
  })
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
