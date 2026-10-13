// Only the part of net-snmp the monitor uses.
declare module 'net-snmp' {
  export interface Varbind {
    oid: string
    type: number
    value: unknown
  }
  export interface Session {
    get(oids: string[], cb: (err: Error | null, varbinds: Varbind[]) => void): void
    subtree(oid: string, maxRepetitions: number, feed: (varbinds: Varbind[]) => void, done: (err?: Error) => void): void
    close(): void
    on(event: 'error', cb: (err: Error) => void): void
  }
  export const Version2c: number
  export function createSession(target: string, community: string, options?: { version?: number; timeout?: number; retries?: number; port?: number }): Session
  export function isVarbindError(v: Varbind): boolean
  const snmp: {
    Version2c: number
    createSession: typeof createSession
    isVarbindError: typeof isVarbindError
  }
  export default snmp
}
