import snmp, { type Session, type Varbind } from 'net-snmp'
import type { SnmpStatus } from '@shared/types'

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  // HUAWEI-ENTITY-EXTENT-MIB hwEntityTemperature, °C per board.
  huaweiTemp: '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.11',
  // MIKROTIK-MIB mtxrHlTemperature (RouterOS 6, tenths of °C) and mtxrGaugeTable (RouterOS 7).
  mikrotikTemp: '1.3.6.1.4.1.14988.1.1.3.10.0',
  mikrotikGaugeValue: '1.3.6.1.4.1.14988.1.1.3.100.1.3',
  mikrotikGaugeUnit: '1.3.6.1.4.1.14988.1.1.3.100.1.4',
  // CISCO-ENVMON-MIB ciscoEnvMonTemperatureStatusValue.
  ciscoTemp: '1.3.6.1.4.1.9.9.13.1.3.1.3',
  // ENTITY-SENSOR-MIB: type 8 = celsius.
  entSensorType: '1.3.6.1.2.1.99.1.1.1.1',
  entSensorValue: '1.3.6.1.2.1.99.1.1.1.4'
}

const ENTERPRISE = { huawei: '1.3.6.1.4.1.2011.', mikrotik: '1.3.6.1.4.1.14988.', cisco: '1.3.6.1.4.1.9.' }

function get(s: Session, oids: string[]): Promise<Varbind[]> {
  return new Promise((resolve, reject) => s.get(oids, (err, vbs) => (err ? reject(err) : resolve(vbs))))
}

/** Rows under a table column, keyed by the index suffix. */
function column(s: Session, base: string): Promise<Map<string, number>> {
  const rows = new Map<string, number>()
  return new Promise((resolve) =>
    s.subtree(
      base,
      20,
      (vbs) => vbs.forEach((v) => !snmp.isVarbindError(v) && rows.set(v.oid.slice(base.length + 1), Number(v.value))),
      () => resolve(rows)
    )
  )
}

const plausible = (t: number) => Number.isFinite(t) && t > 0 && t < 150

async function temperature(s: Session, objectId: string): Promise<number | undefined> {
  const max = (xs: number[]) => (xs.filter(plausible).length ? Math.max(...xs.filter(plausible)) : undefined)
  if (objectId.startsWith(ENTERPRISE.huawei)) {
    const t = max([...(await column(s, OID.huaweiTemp)).values()])
    if (t !== undefined) return t
  }
  if (objectId.startsWith(ENTERPRISE.mikrotik)) {
    const [v] = await get(s, [OID.mikrotikTemp]).catch(() => [])
    if (v && !snmp.isVarbindError(v) && plausible(Number(v.value) / 10)) return Number(v.value) / 10
    const [values, units] = await Promise.all([column(s, OID.mikrotikGaugeValue), column(s, OID.mikrotikGaugeUnit)])
    const t = max([...values].filter(([i]) => units.get(i) === 1).map(([, v]) => v))
    if (t !== undefined) return t
  }
  if (objectId.startsWith(ENTERPRISE.cisco)) {
    const t = max([...(await column(s, OID.ciscoTemp)).values()])
    if (t !== undefined) return t
  }
  const [types, values] = await Promise.all([column(s, OID.entSensorType), column(s, OID.entSensorValue)])
  return max([...values].filter(([i]) => types.get(i) === 8).map(([, v]) => v))
}

// Huawei puts a generic banner first and the model/version on the next line.
function describe(sysDescr: string): string {
  const lines = sysDescr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return (lines.find((l) => /version/i.test(l)) ?? lines[0] ?? '').slice(0, 200)
}

/** SNMP v2c poll over UDP 161: does not use an SSH/VTY line on the device. */
export async function pollSnmp(address: string, community: string, port = 161): Promise<SnmpStatus> {
  const s = snmp.createSession(address, community, { version: snmp.Version2c, timeout: 1500, retries: 1, port })
  s.on('error', () => {})
  try {
    const vbs = await get(s, [OID.sysName, OID.sysDescr, OID.sysUpTime, OID.sysObjectID])
    const val = (i: number) => (snmp.isVarbindError(vbs[i]) ? undefined : vbs[i].value)
    const objectId = String(val(3) ?? '')
    return {
      ok: true,
      sysName: val(0) !== undefined ? String(val(0)) : undefined,
      sysDescr: val(1) !== undefined ? describe(String(val(1))) : undefined,
      uptime: val(2) !== undefined ? Math.round(Number(val(2)) / 100) : undefined,
      temp: await temperature(s, objectId).catch(() => undefined)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: /timed out/i.test(msg) ? 'нет ответа SNMP (порт 161 или community)' : msg }
  } finally {
    s.close()
  }
}
