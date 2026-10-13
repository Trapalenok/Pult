export type AlgoProfile = 'modern' | 'compat' | 'legacy'

/** Accent colours from the design system palette (see design/tokens.css). */
export type Tint = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'teal' | 'indigo' | 'pink' | 'gray'

/** What a folder stands for physically; only changes its icon. */
export type FolderKind = 'folder' | 'building' | 'floor' | 'room' | 'rack' | 'cross'

/** What a host is, for its icon only. Unset: a router for WinBox hosts, otherwise a server. */
export type HostIcon = 'server' | 'router' | 'switch' | 'firewall' | 'wifi' | 'camera' | 'pc' | 'printer' | 'storage' | 'phone'

/** Settings a folder passes down to everything inside it; a host may override each one. */
export interface ConnectionDefaults {
  username?: string
  port?: number
  algoProfile?: AlgoProfile
  /** Template for "open in browser", e.g. https://{address}:8443 */
  webUrl?: string
  winbox?: boolean
  /** Saved account (Credential.id) to log in with. Takes the place of username + password. */
  credentialId?: string
  /** ICMP ping in the background. On by default. */
  ping?: boolean
  /** SNMP v2c polling (UDP 161); needs a community set on this level or above. */
  snmp?: boolean
  /** Go through the jump host from Settings (on by default once it is set up). */
  jump?: boolean
}

export interface Folder {
  id: string
  parentId: string | null
  name: string
  tint?: Tint
  kind?: FolderKind
  defaults: ConnectionDefaults
}

export interface Host {
  id: string
  folderId: string | null
  name: string
  address: string
  tint?: Tint
  icon?: HostIcon
  overrides: ConnectionDefaults
  privateKeyPath?: string
}

/** A saved login. The password lives in the main process under the same id. */
export interface Credential {
  id: string
  name: string
  username: string
}

export interface MapNode {
  id: string
  /** Host this node stands for; a node without one is a plain label (provider, cloud, room). */
  hostId?: string
  /** Child sheet this node opens (a building on the campus sheet, a floor in a building). */
  sheetId?: string
  label?: string
  /** Zone (room) on the same sheet this node sits in; it moves with the zone. */
  zoneId?: string
  /** Top-left corner on the sheet, also for nodes inside a zone. */
  x: number
  y: number
}

export type ZoneShape = 'rect' | 'square' | 'circle'

/** An area drawn on a sheet (a room, a rack row); the nodes inside it belong to it. */
export interface MapZone {
  id: string
  name: string
  shape: ZoneShape
  tint?: Tint
  x: number
  y: number
  w: number
  h: number
}

export interface MapLink {
  id: string
  from: string
  to: string
  /** Interface names on each end, e.g. GE0/0/1 and ether3. */
  fromIf?: string
  toIf?: string
  label?: string
  /** Line shape; curve by default. */
  shape?: LinkShape
  /** Bend point dragged by the user, relative to the straight line's midpoint. */
  bend?: { x: number; y: number }
}

export type LinkShape = 'curve' | 'straight' | 'step'

/** One sheet of the network map. */
export interface NetMap {
  id: string
  name: string
  /** Sheet this one sits inside; top-level sheets are tabs. */
  parentId?: string
  nodes: MapNode[]
  links: MapLink[]
  /** Drawn behind the nodes. Older files have none. */
  zones?: MapZone[]
}

export type ThemeId =
  | 'system' | 'oat' | 'mist' | 'cocoa' | 'midnight' | 'moss' | 'dusk'
  /** Pre-Shellwise themes, kept so old settings load; the renderer maps them to the closest new one. */
  | 'ios-dark' | 'ios-light' | 'termius' | 'nord' | 'solarized-dark' | 'solarized-light' | 'contrast'

export interface AppSettings {
  theme?: ThemeId
  /** Accent colour; each theme has its own default. */
  accent?: Tint
  termFontSize?: number
  /** Seconds between ping/SNMP rounds. */
  monitorInterval?: number
  winboxPath?: string
  /** On unless set to false. The password is visible in the process list while WinBox runs. */
  winboxPassPassword?: boolean
  jump?: JumpHost
  /** Blinking port LEDs and traffic along links on the map. On by default. */
  animations?: boolean
  /** Look for a new release on GitHub at start. On by default. */
  updateCheck?: boolean
}

/**
 * One intermediate server that every session goes through: you → jump host → switch. Either an SSH
 * server (e.g. the "master key" Windows server with OpenSSH) or a SOCKS5 proxy. Hosts and folders
 * can opt out with jump: false.
 */
export interface JumpHost {
  enabled?: boolean
  /** 'ssh' when absent (settings saved before SOCKS5 existed). */
  kind?: JumpKind
  address?: string
  /** 22 for SSH, 1080 for SOCKS5 when absent. */
  port?: number
  /**
   * Saved account (Credential.id): the SSH login on the jump host, or the SOCKS5 login and password.
   * Optional for SOCKS5 (proxy without authentication).
   */
  credentialId?: string
  /** SSH kind only. */
  algoProfile?: AlgoProfile
  /**
   * Monitoring "ping" of hosts behind the jump host goes through it as a TCP connect to the host's
   * SSH port (ICMP can't cross a SOCKS5 proxy or an SSH tunnel). Off: ICMP ping from this PC.
   */
  pingVia?: boolean
}

export type JumpKind = 'ssh' | 'socks5'

export const JUMP_DEFAULT_PORT: Record<JumpKind, number> = { ssh: 22, socks5: 1080 }

/** A saved set of hosts that opens together, as one tab with all its terminals in a grid. */
export interface Workspace {
  id: string
  name: string
  hostIds: string[]
}

export interface Store {
  folders: Folder[]
  hosts: Host[]
  credentials: Credential[]
  maps: NetMap[]
  /** Older files have none. */
  workspaces?: Workspace[]
  settings?: AppSettings
}

/**
 * What the renderer sees. Passwords and SNMP communities stay in the main process (encrypted
 * with safeStorage); the renderer only learns which ids have one.
 */
export interface StoreSnapshot extends Store {
  secretIds: string[]
}

export type EffectiveSettings = Required<Pick<ConnectionDefaults, 'port' | 'algoProfile' | 'webUrl' | 'winbox' | 'ping' | 'snmp' | 'jump'>> &
  Pick<ConnectionDefaults, 'username'>

export interface SessionInfo {
  sessionId: string
  hostId: string
  title: string
}

/** Asked of the user before a host key is trusted (first connect) or when it changed. */
export interface HostKeyPrompt {
  requestId: string
  hostName: string
  address: string
  port: number
  keyType: string
  /** SHA256:… as OpenSSH prints it. */
  fingerprint: string
  /** Set when a different key was trusted before: possible man-in-the-middle. */
  previous?: { keyType: string; fingerprint: string; addedAt: string }
}

export interface SnmpStatus {
  ok: boolean
  sysName?: string
  sysDescr?: string
  /** Seconds. */
  uptime?: number
  /** °C, hottest sensor found. */
  temp?: number
  error?: string
}

export interface HostStatus {
  hostId: string
  /** null = not checked (ping off). */
  alive: boolean | null
  /** Round-trip, ms, last probe. */
  rtt?: number
  /** Last probes, newest last; null = lost. */
  history: (number | null)[]
  /** Set when the ping was a TCP connect through the jump host, e.g. "TCP :22 через SOCKS5-прокси". */
  probe?: string
  snmp?: SnmpStatus
  checkedAt: number
}

/** Secret ids: a password is stored under the host/folder/credential id, a community under `snmp:<id>`. */
export const snmpSecretId = (id: string) => `snmp:${id}`

/** What a config file holds, shown before it is imported. */
export interface ImportPreview {
  /** Handle for importApply; the parsed file waits in the main process. */
  token: string
  fileName: string
  exportedAt?: string
  counts: { folders: number; hosts: number; credentials: number; maps: number; knownHosts: number }
  /** Of those, how many ids this base does not have yet (what "merge" would add). */
  fresh: { folders: number; hosts: number; credentials: number; maps: number }
  /** Passwords and communities are inside, encrypted with the password set at export. */
  hasSecrets: boolean
  hasSettings: boolean
}

export type ImportMode = 'merge' | 'replace'

/* ── Import from another program's base (SQLite, CSV, JSON) ── */

/** Host fields a column of a foreign table can fill. */
export type ForeignField = 'name' | 'address' | 'port' | 'username' | 'password' | 'folder' | 'protocol'

/** Field → column name. A field left out is not imported. */
export type ForeignMapping = Partial<Record<ForeignField, string>>

export interface ForeignTable {
  name: string
  columns: string[]
  rowCount: number
  /** First rows as text; cells of password-like columns are masked. */
  sample: string[][]
  /** Columns guessed from headers and values. */
  guess: ForeignMapping
}

/** What a foreign file holds, shown before anything is imported. */
export interface ForeignPreview {
  /** Handle for foreignPlan / foreignApply; the parsed file waits in the main process. */
  token: string
  fileName: string
  format: 'sqlite' | 'csv' | 'json'
  tables: ForeignTable[]
  /** The table that looks most like a host list. */
  bestTable: string
}

export interface ForeignOptions {
  table: string
  mapping: ForeignMapping
  /** Where hosts go; null = top level. */
  targetFolderId: string | null
  /** Put everything in a folder with this name inside the target (reused if it exists). */
  newFolder?: string
  /** skip: a host whose address and port are already here (or earlier in the file) is left out. */
  duplicates: 'skip' | 'add'
}

/** What an import would do (or did). */
export interface ForeignPlan {
  rows: number
  hosts: number
  duplicates: number
  noAddress: number
  /** Rows whose protocol column says RDP, VNC, Telnet… */
  notSsh: number
  /** Folders that will be created. */
  folders: number
  passwords: number
  /** Most passwords look like hashes or ciphertext from the other program, not real passwords. */
  passwordsLookEncrypted: boolean
  /** Table that folder ids in the folder column were looked up in. */
  folderLookup?: string
  /** First hosts as they will be created. */
  sample: { name: string; address: string; port?: number; username?: string; folder: string; password: boolean }[]
}
