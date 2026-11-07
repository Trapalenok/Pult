// ssh2 keeps its supported lists here; typed in ssh2-constants.d.ts.
import constants from 'ssh2/lib/protocol/constants.js'
import { SignatureError, type Pair } from './session-manager'

/** "address:port" → the KEX method + host key type that passed the signature check there, until Pult restarts. */
const good = new Map<string, Pair>()

/** Host key types to fall back to, most trusted first: RSA before ECDSA and DSA, which some switches sign badly. */
const KEY_ORDER = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-dss']
const MAX_TRIES = 6

/** Pairs the server offers that ssh2 can do, other host key types first, then other KEX methods. */
export function nextPairs(err: SignatureError, tried: Pair[]): Pair[] {
  const kexes = err.serverKex.filter((k) => (constants.SUPPORTED_KEX as string[]).includes(k))
  const keys = KEY_ORDER.filter((k) => err.serverHostKeys.includes(k))
  const failedKeys = new Set(tried.map((p) => p.hostKey))
  // A key type that has not failed yet is tried before a KEX method that has not.
  const byKey = [...keys.filter((k) => !failedKeys.has(k)), ...keys.filter((k) => failedKeys.has(k))]
  const all = byKey.flatMap((hostKey) => kexes.map((kex) => ({ kex, hostKey })))
  return all.filter((p) => !tried.some((t) => t.kex === p.kex && t.hostKey === p.hostKey))
}

/**
 * Some switches (Huawei VRP seen on S5720) sign the handshake wrongly for some host key types or KEX
 * methods. After a signature failure, try the other pairs the server offers, one at a time; the pair
 * that works is remembered for this host. When none works, give up with the signature failure and
 * every handshake's debug lines.
 */
export async function openWithKexRetry(
  id: string,
  open: (only?: Pair) => Promise<string>,
  giveUp: (last: SignatureError, tried: Pair[], log: string[]) => Error
): Promise<string> {
  const tried: Pair[] = []
  const log: string[] = []
  let last: SignatureError | undefined
  let next: Pair | undefined = good.get(id)
  for (;;) {
    try {
      const sessionId = await open(next)
      if (next) good.set(id, next)
      return sessionId
    } catch (err) {
      if (!(err instanceof SignatureError)) {
        // A cached KEX/host-key pair is a hint, not a requirement. If the peer resets
        // the TCP connection before the SSH handshake completes, retry immediately
        // with the full profile instead of making the open queue spend ~4.5 seconds
        // retrying the same stale pair.
        const cached = !!next && next === good.get(id)
        if (cached) good.delete(id)
        const failure = err as Error & { code?: string; sshHandshakeCompleted?: boolean }
        if (cached && failure.code === 'ECONNRESET' && failure.sshHandshakeCompleted !== true) {
          tried.push(next!)
          next = undefined
          continue
        }
        if (!last) throw err
        // A forced pair can fail for other reasons (e.g. the server dropped one method); move on.
        log.push(`=== ${next?.kex} + ${next?.hostKey}: ${(err as Error).message.split('\n')[0]}`)
      } else {
        last = err
        if (err.used) tried.push(err.used)
        log.push(`=== ${err.used ? `${err.used.kex} + ${err.used.hostKey}` : 'попытка'}: подпись не сошлась`, ...(err.log ?? []))
      }
      if (next && !tried.some((t) => t.kex === next!.kex && t.hostKey === next!.hostKey)) tried.push(next)
      if (good.get(id) === next) good.delete(id)
      const candidates = nextPairs(last, tried)
      if (!candidates.length || tried.length >= MAX_TRIES) throw giveUp(last, tried, log)
      next = candidates[0]
    }
  }
}
