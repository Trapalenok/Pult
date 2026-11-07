import { useEffect, useRef, useState } from 'react'
import type { Host, StoreSnapshot } from '@shared/types'
import { lldpPortLabel, matchLldpNeighbor, retainLldpBindings, validLldpSnapshot, type LldpSnapshot, type LldpAutoStatus } from '@shared/lldp'
import { effectiveSettings, snmpCommunityOwner } from '@shared/inherit'
import { Badge, Banner, Button, Group, Row, Select } from '../design/components'

/** Draft-only edits: the parent host sheet's Save/Cancel also applies to neighbor bindings. */
export function LldpHostSection({ hostId, saved, value, store, onChange }: {
  hostId: string; saved: boolean; value?: Host['lldp']; store: StoreSnapshot; onChange(value: LldpSnapshot | undefined): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [automatic, setAutomatic] = useState<LldpAutoStatus>()
  const host = store.hosts.find((h) => h.id === hostId)
  const enabled = host && host.lldpAuto !== false && effectiveSettings(store.folders, host).snmp &&
    !!snmpCommunityOwner(store.folders, host, store.secretIds)
  useEffect(() => {
    let alive = true, received = false
    const off = window.api.onLldpAutoStatus((status) => {
      if (status.hostId === hostId) { received = true; setAutomatic(status) }
    })
    void window.api.lldpAutoStatus().then((statuses) => {
      if (alive && !received) setAutomatic(statuses.find((s) => s.hostId === hostId))
    }).catch(() => {})
    return () => { alive = false; off() }
  }, [hostId])
  const request = useRef<string | null>(null)
  const current = useRef({ value, onChange })
  current.current = { value, onChange }
  useEffect(() => () => {
    const id = request.current
    request.current = null
    if (id) void window.api.lldpCancel(id).catch(() => {})
  }, [])
  const snapshot = validLldpSnapshot(value) ? value : undefined
  const read = async () => {
    const id = crypto.randomUUID()
    request.current = id
    setBusy(true)
    setError('')
    try {
      const result = await window.api.lldpRead(hostId, id)
      if (request.current === id) current.current.onChange(retainLldpBindings(result, validLldpSnapshot(current.current.value) ? current.current.value : undefined))
    } catch (e) {
      if (request.current === id) setError(e instanceof Error ? e.message : 'Не удалось прочитать LLDP.')
    } finally {
      if (request.current === id) { request.current = null; setBusy(false) }
    }
  }
  const bind = (key: string, target: string) => {
    if (snapshot) onChange({ ...snapshot, neighbors: snapshot.neighbors.map((n) => n.key === key ? { ...n, hostId: target || undefined } : n) })
  }
  return <Group header="LLDP · соседи" footer="Автосбор сохраняет снимки сам, по сохранённым настройкам SNMP, напрямую по UDP 161. Ручное чтение и привязки сохраняются кнопкой «Готово». Конфигурация устройств не меняется.">
    <Row label="Автосбор" detail={!enabled ? 'Ожидает включения SNMP, community и автосбора' : automatic?.state === 'running' ? 'Чтение…' : automatic?.state === 'error' ? 'Ошибка; повтор через 5 минут' : automatic?.state === 'ok' ? 'Включён · каждые 5 минут' : 'Ожидает первого опроса'} />
    {enabled && automatic?.state === 'error' && <Banner title="Автосбор LLDP"><span role="status" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{automatic.error}</span></Banner>}
    <Row label="Соседи коммутатора">
      <Button size="sm" disabled={!saved || busy} onClick={read}>{busy ? 'Чтение…' : 'Прочитать LLDP'}</Button>
      {busy && <Button size="sm" variant="plain" onClick={() => { if (request.current) void window.api.lldpCancel(request.current).catch(() => setError('Не удалось отменить запрос.')) }}>Отменить</Button>}
    </Row>
    {!saved && <Row label="Сначала сохраните хост и настройки SNMP." />}
    {error && <Banner title="Чтение LLDP"><span role="alert" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{error.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')}</span></Banner>}
    {!snapshot && <Row label="Сохранённых данных LLDP нет." />}
    {snapshot && <>
      <Row label="Последнее чтение" detail={new Date(snapshot.observedAt).toLocaleString('ru-RU')} />
      <Row label="Chassis ID" detail={snapshot.chassisId.text} />
      <Row label="Адрес опроса" detail={snapshot.address} />
      {!snapshot.neighbors.length && <Row label="В полном ответе LLDP соседи не обнаружены." />}
      {snapshot.neighbors.map((n) => {
        const match = matchLldpNeighbor(n, store.hosts, hostId)
        const targetExists = !!n.hostId && store.hosts.some((h) => h.id === n.hostId && h.id !== hostId)
        const conflict = match.kind === 'conflict' || (!!n.hostId && (match.kind === 'chassis' || match.kind === 'address') && !match.hostIds.includes(n.hostId))
        const knownHost = store.hosts.find((h) => h.id === (targetExists ? n.hostId : match.kind === 'chassis' && !conflict ? match.hostIds[0] : undefined))
        const neighborName = n.systemName || (knownHost ? `Хост Pult: ${knownHost.name}` : 'Имя отсутствует в ответе LLDP')
        const hint = ({ chassis: 'Совпадает Chassis ID', address: 'Совпадает IP', name: 'Совпадает только имя — проверьте', conflict: 'Конфликт идентичности', none: 'Соответствие не найдено' })[match.kind]
        return <div key={n.key}>
          <Row label={<span>{n.localPort} ↔ {lldpPortLabel(n.portId)}<br /><small>{neighborName}</small></span>}>
            <Badge tint={conflict ? 'red' : 'gray'}>{conflict ? 'Проверьте привязку' : hint}</Badge>
          </Row>
          <Row label="Chassis ID соседа" detail={n.chassisId.text} />
          {!n.systemName && !n.addresses.length && <Row label="В ответе нет имени и адреса управления. Для привязки нужен совпавший Chassis ID в базе или ручной выбор хоста." />}
          {!!n.addresses.length && <Row label="Адреса соседа" detail={n.addresses.join(', ')} />}
          {!!n.portDescription && <Row label="Описание порта" detail={n.portDescription} />}
          {n.hostId && !targetExists && <Row label="Привязанный хост удалён или недоступен. Выберите другой." />}
          <Row label="Привязать к хосту">
            <Select value={targetExists ? n.hostId! : ''} onChange={(id) => bind(n.key, id)} options={[
              { value: '', label: 'Не привязан' },
              ...store.hosts.filter((h) => h.id !== hostId).map((h) => ({ value: h.id, label: `${h.name} (${h.address})${match.hostIds.includes(h.id) ? ' · кандидат' : ''}` }))
            ]} />
          </Row>
        </div>
      })}
      <Row label="Сохранённый снимок"><Button size="sm" variant="plain" disabled={busy} onClick={() => onChange(undefined)}>Очистить данные LLDP</Button></Row>
    </>}
  </Group>
}
