import type { ForeignOptions, ForeignPlan, ForeignPreview, HostKeyPrompt, HostStatus, ImportMode, ImportPreview, SessionInfo, Store, StoreSnapshot } from './types'
import type { DnsQuery, DnsResult, ToolEvent, ToolKind, ToolParams } from './tools'

/** API exposed to the renderer as window.api. Secrets go in via setSecret and never come back out. */
export interface Api {
  loadStore(): Promise<StoreSnapshot>
  saveStore(store: Store): Promise<StoreSnapshot>
  /** id: host/folder/credential id for a password, snmpSecretId(id) for a community. null removes. */
  setSecret(id: string, value: string | null): Promise<StoreSnapshot>
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
  connect(hostId: string, cols: number, rows: number): Promise<SessionInfo>
  /** The window that called connect() is asked to confirm unknown or changed host keys. */
  onHostKeyPrompt(cb: (p: HostKeyPrompt) => void): () => void
  answerHostKey(requestId: string, accept: boolean): void
  /** Output printed so far, to replay into a terminal mounted after the session started. */
  scrollback(sessionId: string): Promise<{ data: string; end: number }>
  write(sessionId: string, data: string): void
  broadcast(sessionIds: string[], data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  close(sessionId: string): void
  /** Move a session into its own OS window. Any number of them. */
  popout(session: SessionInfo): void
  /** 'dark' | 'light' | 'system' for the OS-level scheme, plus title bar colours from the theme. */
  setTheme(source: 'system' | 'dark' | 'light'): void
  setChrome(color: string, symbolColor: string): void
  monitorAll(): Promise<HostStatus[]>
  monitorProbe(hostIds: string[]): void
  onMonitor(cb: (changed: HostStatus[]) => void): () => void
  openInBrowser(hostId: string): Promise<void>
  openWinbox(hostId: string): Promise<void>
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
}
