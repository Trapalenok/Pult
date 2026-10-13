import { useState } from 'react'
import type { MapZone, ZoneShape } from '@shared/types'
import { Button, Field, Group, Row, Segmented, Sheet } from '../design/components'
import { TintPicker } from '../sheets/fields'

export const ZONE_SHAPES: { value: ZoneShape; label: string; icon: 'shapeRect' | 'shapeSquare' | 'shapeCircle' }[] = [
  { value: 'rect', label: 'Прямоугольник', icon: 'shapeRect' },
  { value: 'square', label: 'Квадрат', icon: 'shapeSquare' },
  { value: 'circle', label: 'Круг', icon: 'shapeCircle' }
]

/** Square and circle keep equal sides; switching to them evens the zone out. */
export function withShape(z: MapZone, shape: ZoneShape): MapZone {
  if (shape === 'rect' || z.w === z.h) return { ...z, shape }
  const side = Math.max(z.w, z.h)
  return { ...z, shape, w: side, h: side }
}

export function ZoneSheet({ zone, hosts, onCancel, onSave, onDelete }: { zone: MapZone; hosts: number; onCancel(): void; onSave(z: MapZone): void; onDelete(): void }) {
  const [draft, setDraft] = useState(zone)
  return (
    <Sheet title="Зона" onCancel={onCancel} onDone={() => onSave({ ...draft, name: draft.name.trim() || zone.name })}>
      <Group footer="Хосты, перетащенные в зону, принадлежат ей и двигаются вместе с ней. Тяните зону за название, размер меняется за углы.">
        <Row label="Название">
          <Field autoFocus value={draft.name} placeholder="Серверная 2.14" onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onSave({ ...draft, name: draft.name.trim() || zone.name })} />
        </Row>
        <Row label="Форма">
          <Segmented<ZoneShape> value={draft.shape} onChange={(shape) => setDraft(withShape(draft, shape))} options={ZONE_SHAPES.map(({ value, label }) => ({ value, label }))} />
        </Row>
        <Row label={<TintPicker value={draft.tint} onChange={(tint) => setDraft({ ...draft, tint })} />} />
      </Group>
      <div className="sheet-danger">
        <Button variant="destructive" icon="trash" onClick={onDelete}>Удалить зону</Button>
        <p className="muted">{hosts ? 'Хосты останутся на листе на своих местах.' : 'В зоне нет хостов.'}</p>
      </div>
    </Sheet>
  )
}
