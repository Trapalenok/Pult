/** Nothing answered at that address (as opposed to a refused login or key): worth trying the host's next address. */
export function unreachable(err: unknown): boolean {
  const e = err as { message?: string; code?: string }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e?.code ?? '')) return true
  return /не отвечает|недоступен по сети|Порт закрыт|timed out|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|connection refused|no route|unreachable/i.test(e?.message ?? '')
}

/**
 * Opens a session at the first of a host's addresses that answers, in the given order. Only
 * "nobody answered there" moves on to the next address: a wrong password or a refused key would be
 * the same on all of them and shows at once. When every address fails, the error lists each one.
 */
export async function openFirstReachable<T>(order: string[], openAt: (address: string) => Promise<T>): Promise<{ result: T; address: string }> {
  const failed: string[] = []
  for (const [i, address] of order.entries()) {
    try {
      return { result: await openAt(address), address }
    } catch (err) {
      if (i === order.length - 1 || !unreachable(err)) {
        if (!failed.length) throw err
        throw new Error([...failed, `${address}: ${(err as Error).message}`].join('\n'))
      }
      failed.push(`${address}: ${(err as Error).message}`)
    }
  }
  throw new Error('У хоста нет адреса')
}
