import type { MapBackgroundFile, ForeignOptions, ForeignPlan, ForeignPreview, HostKeyPrompt, HostStatus, ImportMode, ImportPreview, SessionInfo, Store, StoreSnapshot } from './types'
import type { DnsQuery, DnsResult, ToolEvent, ToolKind, ToolParams } from './tools'
import type { LldpSnapshot, LldpAutoStatus } from './lldp'

/** API exposed to the renderer as window.api. Secrets go in via setSecret and never come back out. */
export interface Api {
  lldpAutoStatus(): Promise<LldpAutoStatus[]>
  onLldpAutoStatus(cb: (status: LldpAutoStatus) => void): () => void
  /** Explicit read-only SNMP request; opening a host never starts it. */
  lldpRead(hostId: string, requestId: string): Promise<LldpSnapshot>
  lldpCancel(requestId: string): Promise<void>
  loadStore(): Promise<StoreSnapshot>
  saveStore(store: Store): Promise<StoreSnapshot>
  /** id: host/folder/credential id for a password, snmpSecretId(id) for a community. null removes. */
  setSecret(id: string, value: string | null): Promise<StoreSnapshot>
  /** The main process changed the base itself (a login typed in a session was remembered). */
  onStoreChanged(cb: (store: StoreSnapshot) => void): () => void
  /**
   * Save dialog, then writes the whole base to one JSON file. With a password, passwords and SNMP
   * communities go in too, encrypted with it; otherwise they are left out. Null when cancelled.
   */
  exportConfig(password?: string): Promise<string | null>
  /** Open dialog, then reads and checks the file. Null when cancelled; throws on a bad file. */
  importPick(): Promise<ImportPreview | null>
  /** merge: add what is missing, keep everything already here. replace: the file becomes the base. */
  importApply(token: string, mode: ImportMode, password?: string): Promise<StoreSnapshot>
  /** Open dialog for another program's base (SQLite, CSV, JSON). Null when cancelled. Never modifies the file. */
  foreignPick(): Promise<ForeignPreview | null>
  /** Dry run: what foreignApply would do with these options. */
  foreignPlan(token: string, opts: ForeignOptions): Promise<ForeignPlan>
  /** Adds the hosts (and folders); passwords go straight into the encrypted store. */
  foreignApply(token: string, opts: ForeignOptions): Promise<{ snapshot: StoreSnapshot; plan: ForeignPlan }>
  /** address: go only there; without it the host's addresses are tried in turn until one answers. */
  connect(hostId: string, cols: number, rows: number, address?: string): Promise<SessionInfo>
  /** A closed session connects again under the same id, in the same pane; its output carries on below the old. */
  reconnect(sessionId: string, hostId: string, address?: string): Promise<SessionInfo>
  /** The window that called connect() is asked to confirm unknown or changed host keys. */
  onHostKeyPrompt(cb: (p: HostKeyPrompt) => void): () => void
  answerHostKey(requestId: string, accept: boolean): void
  /** The connection behind a question gave up before it was answered: take the question away. */
  onHostKeyCancel(cb: (requestId: string) => void): () => void
  /** Output printed so far, to replay into a terminal mounted after the session started. */
  scrollback(sessionId: string): Promise<{ data: string; end: number }>
  write(sessionId: string, data: string): void
  broadcast(sessionIds: string[], data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  close(sessionId: string): void
  /** Move a session into its own OS window. Any number of them. */
  popout(session: SessionInfo): void
  /** The main window's UI has the base on screen: the start-up logo window can go. */
  ready(): void
  /** 'dark' | 'light' | 'system' for the OS-level scheme, plus title bar colours from the theme. */
  setTheme(source: 'system' | 'dark' | 'light'): void
  /** Title bar colours and height (the caption buttons sit in it; each design system has its own bar height). */
  setChrome(color: string, symbolColor: string, height?: number): void
  monitorAll(): Promise<HostStatus[]>
  monitorProbe(hostIds: string[]): void
  onMonitor(cb: (changed: HostStatus[]) => void): () => void
  /** address: one of the host's addresses; by default the one monitoring last saw answer. */
  openInBrowser(hostId: string, address?: string): Promise<void>
  openWinbox(hostId: string, address?: string): Promise<void>
  /** end: session offset just after this chunk, to skip chunks already replayed from scrollback. */
  onData(cb: (sessionId: string, data: string, end: number) => void): () => void
  onClosed(cb: (sessionId: string, reason: string) => void): () => void
  /** A popped-out window was closed with its session still alive: show it in the main window again. */
  onReturned(cb: (session: SessionInfo) => void): () => void
  /** Network tools: results stream to onToolEvent under runId until a 'done' event. */
  toolStart<K extends ToolKind>(runId: string, kind: K, params: ToolParams[K]): void
  toolStop(runId: string): void
  onToolEvent(cb: (runId: string, ev: ToolEvent) => void): () => void
  dnsQuery(q: DnsQuery): Promise<DnsResult>
  /** Open dialog for a map backdrop picture; it is copied next to the base. Null when cancelled. */
  pickMapBackground(): Promise<MapBackgroundFile | null>
  /** A backdrop picture as a data: URL; null when the file is missing. */
  loadMapBackground(file: string): Promise<string | null>
}
