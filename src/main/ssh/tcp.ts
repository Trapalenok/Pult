import { connect, type Socket } from 'net'

/** How long a direct TCP connect may take: a switch on the LAN answers in milliseconds, a dead address never does. */
export const CONNECT_TIMEOUT_MS = 8000

/**
 * TCP connection to address:port, given up after timeoutMs. ssh2 has only readyTimeout (90 s, it also covers
 * the time the user reads the host key dialog), so an address that drops SYN packets would otherwise hold a
 * place in the open queue for up to 90 s and every host behind it in the pack would wait.
 */
export function tcpConnect(address: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: address, port })
    const fail = (err: Error & { code?: string }) => {
      sock.destroy()
      reject(err)
    }
    sock.setTimeout(timeoutMs, () => fail(Object.assign(new Error('Хост не отвечает (таймаут).'), { code: 'ETIMEDOUT' })))
    sock.once('error', (e: Error & { code?: string }) => {
      if (e.code === 'ECONNREFUSED') fail(Object.assign(new Error('Порт закрыт: SSH на хосте не отвечает.'), { code: e.code }))
      else if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') fail(Object.assign(new Error('Хост недоступен по сети.'), { code: e.code }))
      else fail(e)
    })
    sock.once('connect', () => {
      sock.setTimeout(0)
      sock.removeAllListeners('error')
      resolve(sock)
    })
  })
}
