import { useState } from 'react'
import type { LinkShape, MapLink } from '@shared/types'
import { Button, Field, Group, Row, Segmented, Sheet } from '../design/components'

export function LinkSheet({ link, fromName, toName, onCancel, onSave, onDelete }: {
  link: MapLink
  fromName: string
  toName: string
  onCancel(): void
  onSave(l: MapLink): void
  onDelete(): void
}) {
  const [d, setD] = useState(link)
  return (
    <Sheet title="Связь" onCancel={onCancel} onDone={() => onSave(d)}>
      <Group footer="Интерфейсы показываются подписью на линии, например GE0/0/1 ↔ ether3.">
        <Row label={`Порт на ${fromName}`}>
          <Field autoFocus value={d.fromIf ?? ''} placeholder="GE0/0/1" onChange={(e) => setD({ ...d, fromIf: e.target.value || undefined })} />
        </Row>
        <Row label={`Порт на ${toName}`}>
          <Field value={d.toIf ?? ''} placeholder="ether3" onChange={(e) => setD({ ...d, toIf: e.target.value || undefined })} />
        </Row>
        <Row label="Подпись">
          <Field value={d.label ?? ''} placeholder="VLAN 10, 10G, LACP…" onChange={(e) => setD({ ...d, label: e.target.value || undefined })} />
        </Row>
      </Group>
      <Group header="Линия" footer="Изгиб: выберите связь на карте и тяните точку посередине. Двойной клик по точке выпрямляет.">
        <Row label="Форма">
          <Segmented<LinkShape>
            size="sm"
            value={d.shape ?? 'curve'}
            onChange={(shape) => setD({ ...d, shape })}
            options={[{ value: 'curve', label: 'Дуга' }, { value: 'straight', label: 'Прямая' }, { value: 'step', label: 'Ступенька' }]}
          />
        </Row>
        {d.bend && (
          <Row label="Изгиб">
            <Button variant="plain" size="sm" onClick={() => setD({ ...d, bend: undefined })}>Выпрямить</Button>
          </Row>
        )}
      </Group>
      <div className="sheet-danger">
        <Button variant="destructive" icon="trash" onClick={onDelete}>Удалить связь</Button>
      </div>
    </Sheet>
  )
}
