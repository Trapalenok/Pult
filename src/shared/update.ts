/** Updates come from the GitHub Releases of the public repository; nothing else is ever downloaded. */
export const UPDATE_REPO = 'Trapalenok/Pult'

/** How this copy runs: the installed app (NSIS), the portable exe, or from sources. */
export type InstallKind = 'setup' | 'portable' | 'dev'

export interface ReleaseAsset {
  name: string
  url: string
  size: number
  /** "sha256:…" when GitHub reports it. */
  digest?: string
}

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  /** Markdown from the release page. */
  notes: string
  publishedAt: string
  /** The file this copy would install: the setup exe or the portable exe. Missing: can't update to it. */
  asset?: ReleaseAsset
}

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface UpdateState {
  current: string
  kind: InstallKind
  phase: UpdatePhase
  /** Newest first. Empty until the first successful check. */
  releases: ReleaseInfo[]
  /** Newest release, when it is newer than the running one. */
  available?: string
  checkedAt?: string
  /** downloading: 0..1, or undefined when the size is unknown. */
  progress?: number
  /** downloaded: the version waiting to be installed. */
  ready?: string
  error?: string
}

/** 0.3.10 > 0.3.9; a leading "v" and anything after "-" or "+" are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

/** The release file for this kind of install, by the names the Release workflow gives them. */
export function pickAsset<T extends { name: string }>(assets: T[], kind: InstallKind): T | undefined {
  const re = kind === 'portable' ? /^Pult-.+-portable\.exe$/i : /^Pult-Setup-.+\.exe$/i
  return assets.find((a) => re.test(a.name))
}

/** Releases between `from` (exclusive) and `to` (inclusive), newest first: what an update brings. */
export function releasesBetween(releases: ReleaseInfo[], from: string, to: string): ReleaseInfo[] {
  return releases.filter((r) => compareVersions(r.version, from) > 0 && compareVersions(r.version, to) <= 0)
}
