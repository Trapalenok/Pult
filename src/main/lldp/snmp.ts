import snmp, { type Session } from 'net-snmp'
import { LLDP_LOCAL, LLDP_REMOTE, parseLldp, type LldpVarbind } from './parse'
import type { LldpSnapshot } from '@shared/lldp'
import { LldpReadError } from './errors'

const CHANGE = '1.0.8802.1.1.2.1.2.1.0'
const UPTIME = '1.3.6.1.2.1.1.3.0'

/** Read-only SNMP collector shared by scheduled and explicit requests. Injectable for offline tests. */
export async function collectLldp(address: string, community: string, signal: AbortSignal,
  create: () => Session = () => snmp.createSession(address, community, { version: snmp.Version2c, timeout: 1500, retries: 1 }),
  deadlineMs = 30000): Promise<LldpSnapshot> {
  if (signal.aborted) throw new Error('Чтение LLDP отменено.')
  const session = create()
  let stop: (e: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => { stop = reject })
  const cancel = () => stop(new Error('Чтение LLDP отменено.'))
  const timer = setTimeout(() => stop(new Error('Истекло время чтения LLDP; предыдущие данные сохранены.')), deadlineMs)
  signal.addEventListener('abort', cancel, { once: true })
  session.on('error', () => stop(new Error('Ошибка соединения SNMP; предыдущие данные сохранены.')))
  const read = () => new Promise<(number | undefined)[]>((resolve, reject) => session.get([CHANGE, UPTIME], (err, vbs) => {
    if (err) {
      reject(new LldpReadError('Не получен корректный ответ на SNMP GET. Проверьте доступность UDP 161 и сохранённый community.'))
    } else if (vbs.length !== 2) {
      reject(new LldpReadError('SNMP вернул неполный ответ на запрос контрольных счётчиков.'))
    } else resolve(vbs.map((v) => snmp.isVarbindError(v) || typeof v.value !== 'number' || !Number.isFinite(v.value) ? undefined : v.value))
  }))
  const rows: LldpVarbind[] = []
  let bytes = 0
  const walk = (base: string) => new Promise<void>((resolve, reject) => session.subtree(base, 20, (vbs) => {
    for (const v of vbs) {
      if (snmp.isVarbindError(v)) { reject(new LldpReadError(`SNMP отвечает, но ветка ${base} недоступна или вернула неполные данные. Проверьте read-view community для LLDP 1.0.8802.1.1.2.`)); return }
      if (!v.oid.startsWith(base + '.')) { reject(new Error('Некорректный ответ LLDP-MIB.')); return }
      bytes += Buffer.isBuffer(v.value) ? v.value.length : String(v.value).length
      if (rows.length >= 100000 || bytes > 2 * 1024 * 1024) { reject(new Error('Ответ LLDP превысил допустимый размер.')); return }
      rows.push({ oid: v.oid, value: v.value })
    }
  }, (err) => err ? reject(new LldpReadError(`Не удалось завершить SNMP-обход ветки ${base}. Предыдущие данные сохранены.`)) : resolve()))
  // Race each operation individually so cancellation cannot start another request afterwards.
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, failed])
  try {
    const before = await bounded(read())
    await bounded(walk(LLDP_LOCAL))
    if (!rows.some((v) => v.oid === `${LLDP_LOCAL}.2.0`)) {
      throw new LldpReadError('SNMP отвечает, но локальные данные LLDP не получены из 1.0.8802.1.1.2. Проверьте доступ community к этой ветке и поддержку/включение LLDP. На Huawei стандартная ViewDefault может разрешать только 1.3.6.1.')
    }
    await bounded(walk(LLDP_REMOTE))
    const after = await bounded(read())
    const changed = (a: (number | undefined)[], b: (number | undefined)[]) =>
      (a[0] !== undefined && b[0] !== undefined && a[0] !== b[0]) ||
      (a[1] !== undefined && b[1] !== undefined && b[1] < a[1])
    if (changed(before, after)) throw new LldpReadError('Таблица LLDP изменилась или устройство перезапустилось; повторите запрос.')
    // Some devices/views omit the statistics scalar. Compare two complete walks instead;
    // do not silently accept a potentially inconsistent snapshot without a change guard.
    if (before.some((v) => v === undefined) || after.some((v) => v === undefined)) {
      const canonical = () => JSON.stringify([...rows].sort((a, b) => a.oid.localeCompare(b.oid)))
      const first = canonical()
      rows.length = 0
      bytes = 0
      await bounded(walk(LLDP_LOCAL))
      await bounded(walk(LLDP_REMOTE))
      const final = await bounded(read())
      if (first !== canonical() || changed(after, final)) throw new LldpReadError('Повторное чтение LLDP дало другой результат; предыдущие данные сохранены. Повторите запрос.')
    }
    return parseLldp(rows, address)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    session.close()
  }
}
