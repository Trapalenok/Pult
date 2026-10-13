import { useMemo, useState } from 'react'
import type { StoreSnapshot, Workspace } from '@shared/types'
import { Button, Field, Group, Row, SearchField, Sheet } from '../design/components'
import { Icon } from '../design/icons'
import { folderPath, newId, plural } from '../util'

/**
 * A workspace: a named set of hosts that opens as one tab, every terminal in one grid.
 * Hosts are ticked in a searchable list; the order they were ticked in is the grid order.
 */
export function WorkspaceSheet({ store, workspace, initialHostIds, initialName, onCancel, onSave, onDelete }: {
  store: StoreSnapshot
  workspace: Workspace | null
  /** Pre-ticked hosts for a new workspace (picked cards, an open group of sessions). */
  initialHostIds?: string[]
  initialName?: string
  onCancel(): void
  onSave(w: Workspace): void
  onDelete(w: Workspace): void
}) {
  const [draft, setDraft] = useState<Workspace>(workspace ?? { id: newId(), name: initialName ?? '', hostIds: initialHostIds ?? [] })
  const [query, setQuery] = useState('')
  const ticked = new Set(draft.hostIds)
  const q = query.trim().toLowerCase()
  const hosts = useMemo(() => {
    const list = store.hosts.map((h) => ({ h, path: h.folderId ? folderPath(store.folders, h.folderId) : '' }))
    const match = q ? list.filter(({ h, path }) => `${h.name} ${h.address} ${path}`.toLowerCase().includes(q)) : list
    // Ticked first, in grid order; then the rest by folder and name.
    const order = new Map(draft.hostIds.map((id, i) => [id, i]))
    return match.sort((a, b) =>
      ticked.has(a.h.id) !== ticked.has(b.h.id)
        ? ticked.has(a.h.id) ? -1 : 1
        : ticked.has(a.h.id)
          ? order.get(a.h.id)! - order.get(b.h.id)!
          : a.path.localeCompare(b.path, 'ru') || a.h.name.localeCompare(b.h.name, 'ru')
    )
    // Re-sort only when the list or the search changes, not on every tick, so rows don't jump under the pointer.
  }, [store, q])
  const toggle = (id: string) =>
    setDraft({ ...draft, hostIds: ticked.has(id) ? draft.hostIds.filter((x) => x !== id) : [...draft.hostIds, id] })

  return (
    <Sheet
      title={workspace ? 'Workspace' : 'Новый Workspace'}
      onCancel={onCancel}
      onDone={() => onSave({ ...draft, name: draft.name.trim() })}
      doneDisabled={!draft.name.trim() || draft.hostIds.length === 0}
      doneLabel={workspace ? 'Готово' : 'Создать'}
    >
      <Group footer="Workspace открывается одной вкладкой: все его коммутаторы сразу в одной сетке, и ввод broadcast идёт только в них.">
        <Row label="Название">
          <Field autoFocus value={draft.name} placeholder="Ядро, корпус А" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Row>
      </Group>

      <Group header={`Хосты: ${plural(draft.hostIds.length, 'выбран', 'выбрано', 'выбрано')}`}>
        <div className="ws-picker">
          <SearchField value={query} onChange={setQuery} placeholder="Имя, адрес или папка" />
          <div className="link-picker__list">
            {hosts.map(({ h, path }) => (
              <button key={h.id} type="button" className={`link-picker__item ${ticked.has(h.id) ? 'is-picked' : ''}`} onClick={() => toggle(h.id)}>
                <span className="link-picker__check">{ticked.has(h.id) && <Icon name="check" size={14} />}</span>
                <span className="link-picker__name">
                  {h.name}
                  <small>{h.address}{path && ` · ${path}`}</small>
                </span>
              </button>
            ))}
            {hosts.length === 0 && <p className="link-picker__empty muted">Ничего не найдено</p>}
          </div>
        </div>
      </Group>

      {workspace && (
        <div className="sheet-danger">
          <Button variant="destructive" icon="trash" onClick={() => onDelete(workspace)}>Удалить Workspace</Button>
          <p className="muted">Хосты останутся на месте, удаляется только набор.</p>
        </div>
      )}
    </Sheet>
  )
}
