/**
 * Opening many SSH sessions at once (a map sheet, a folder, 20+ switches for broadcast) is
 * throttled here. Jump hosts and proxies cap how many connections may sit in the handshake at the
 * same time (OpenSSH MaxStartups, proxy worker pools, switch SSH limits) and silently drop the rest,
 * which ssh2 reports as "Connection lost before handshake". So sessions open a few at a time, a
 * connection dropped before the handshake is tried again after a pause, and each drop lowers the
 * number opened at once (down to one) until the pack is through.
 */

/** Sessions in the handshake at the same time. */
export const OPEN_CONCURRENCY = 3
/** Pauses before the 2nd and 3rd try, ms. */
export const RETRY_DELAYS = [1500, 3000]

export class OpenQueue {
  private active = 0
  private waiting: (() => void)[] = []
  private limit: number

  constructor(private max = OPEN_CONCURRENCY) {
    this.limit = max
  }

  /**
   * Opens a session with fn once a slot is free. A connection dropped before the handshake gives
   * its slot up, lowers the number opened at once, and queues again after a pause.
   */
  async open<T>(fn: () => Promise<T>, delays = RETRY_DELAYS): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.acquire()
      try {
        return await fn()
      } catch (err) {
        if (attempt >= delays.length || !droppedBeforeHandshake(err)) throw err
        this.limit = Math.max(1, this.limit - 1)
      } finally {
        this.release()
      }
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit && !this.waiting.length) this.active++
    else await new Promise<void>((r) => this.waiting.push(r))
  }

  private release(): void {
    this.active--
    while (this.active < this.limit && this.waiting.length) {
      this.active++
      this.waiting.shift()!()
    }
    // The pack is through: the next one starts at full speed again.
    if (this.active === 0 && !this.waiting.length) this.limit = this.max
  }
}

/**
 * The far side hung up before SSH got going: worth another try, unlike a wrong password or a closed port.
 * A busy switch or jump host may also answer with a text line instead of the SSH version string
 * (a bare "\r" in it is ssh2's "Invalid header: expected newline") and hang up.
 */
export function droppedBeforeHandshake(err: unknown): boolean {
  const e = err as { message?: string; code?: string }
  if (e?.code === 'ECONNRESET' || e?.code === 'EPIPE') return true
  return /lost before handshake|закрыл соединение|ECONNRESET|socket hang up|invalid header|invalid identification string|max greeting lines/i.test(
    e?.message ?? ''
  )
}
