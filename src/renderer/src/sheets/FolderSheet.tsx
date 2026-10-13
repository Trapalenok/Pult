import { useState } from 'react'
import { effectiveSettings } from '@shared/inherit'
import type { Folder, FolderKind, StoreSnapshot } from '@shared/types'
import { Button, Field, Group, Row, Sheet, Toggle } from '../design/components'
import { describeOwn, folderPath, kindMeta, newId, ownSummary, subtreeIds } from '../util'
import { CommunityRow, connectionRows, FolderSelect, inheritedLogin, initialLogin, KindPicker, LoginRows, TintPicker, type LoginDraft } from './fields'
import type { SecretEdits } from './HostSheet'

interface Props {
  store: StoreSnapshot
  folder: Folder | null
  defaultParentId: string | null
  onCancel(): void
  /** applyInside: everything inside drops its own settings and inherits again. */
  onSave(folder: Folder, secrets: SecretEdits, applyInside: boolean): void
  onDelete(folder: Folder): void
}

export function FolderSheet({ store, folder, defaultParentId, onCancel, onSave, onDelete }: Props) {
  const parent = store.folders.find((f) => f.id === defaultParentId)
  // Inside a building the next level is a floor, inside a floor a room, and so on.
  const [draft, setDraft] = useState<Folder>(
    folder ?? { id: newId(), parentId: defaultParentId, name: '', kind: parent ? kindMeta(parent.kind).next : 'folder', defaults: {} }
  )
  const [login, setLogin] = useState<LoginDraft>(() => initialLogin(draft.id, draft.defaults, store.secretIds))
  const [community, setCommunity] = useState('')
  const [clearCommunity, setClearCommunity] = useState(false)
  const [applyInside, setApplyInside] = useState(false)
  // Hosts and subfolders at any depth inside, and what they set themselves.
  const inside = folder ? subtreeIds(store.folders, folder.id) : new Set<string>()
  const own = folder
    ? ownSummary(store, store.hosts.filter((h) => h.folderId && inside.has(h.folderId)).map((h) => h.id), [...inside].filter((id) => id !== folder.id))
    : null

  // Inherited values = what a host placed directly in this folder's parent would get.
  const probe = { id: '\0', folderId: draft.parentId, name: '', address: '', overrides: {} }
  const inherited = effectiveSettings(store.folders, probe)
  const rows = connectionRows({ value: draft.defaults, inherited, onChange: (defaults) => setDraft({ ...draft, defaults }) })
  const snmpOn = draft.defaults.snmp ?? inherited.snmp
  const kind = kindMeta(draft.kind)

  return (
    <Sheet
      title={folder ? `Изменить: ${kind.label.toLowerCase()}` : `Новая папка: ${kind.label.toLowerCase()}`}
      onCancel={onCancel}
      onDone={() => onSave({ ...draft, name: draft.name.trim() }, { login, community: community ? community : clearCommunity ? null : undefined }, applyInside)}
      doneDisabled={!draft.name.trim()}
      doneLabel={folder ? 'Готово' : 'Создать'}
    >
      <Group header="Тип">
        <Row label={<KindPicker value={draft.kind} onChange={(k: FolderKind) => setDraft({ ...draft, kind: k })} />} />
      </Group>

      <Group footer={draft.parentId ? `Путь: ${folderPath(store.folders, draft.parentId)} / ${draft.name || '…'}` : undefined}>
        <Row label="Название">
          <Field autoFocus value={draft.name} placeholder={{ building: 'Корпус А', floor: 'Этаж 1', room: 'Серверная', rack: 'Стойка 3', cross: 'Кросс 1', folder: 'Huawei' }[draft.kind ?? 'folder']} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Row>
        <Row label="Внутри" icon="folder" tint="gray">
          <FolderSelect folders={store.folders} value={draft.parentId} exclude={draft.id} onChange={(parentId) => setDraft({ ...draft, parentId })} />
        </Row>
        <Row label={<TintPicker value={draft.tint} onChange={(tint) => setDraft({ ...draft, tint })} />} />
      </Group>

      <Group header="Для всех хостов внутри" footer="Хосты и подпапки берут эти значения, если не задали свои. Удобно, когда у всего здания или серверной одна учётка.">
        <LoginRows store={store} ownerId={draft.id} draft={login} onChange={setLogin} inherited={inheritedLogin(store, draft.parentId)} />
        {rows.port}
        {rows.algo}
        {store.settings?.jump?.enabled && rows.jump}
      </Group>

      {own && own.items > 0 && (
        <Group
          footer={
            applyInside
              ? `При сохранении ${own.items} шт. внутри забудут свои значения (${describeOwn(own.fields)}) и возьмут их по цепочке папок, на любой глубине.`
              : `Внутри у ${own.items} шт. свои значения, и папка на них не действует: ${describeOwn(own.fields)}.`
          }
        >
          <Row label="Всё внутри берёт настройки папок" icon="folder" tint="orange">
            <Toggle checked={applyInside} onChange={setApplyInside} label="Всё внутри берёт настройки папок" />
          </Row>
        </Group>
      )}

      <Group header="Мониторинг" footer="Ping и SNMP не занимают VTY-линии на оборудовании.">
        {rows.ping}
        {rows.snmp}
        {snmpOn && (
          <CommunityRow store={store} ownerId={draft.id} probe={probe} value={community} cleared={clearCommunity} onChange={setCommunity} onClear={() => setClearCommunity(true)} />
        )}
      </Group>

      <Group header="Интеграции">
        {rows.web}
        {rows.winbox}
      </Group>

      {folder && (
        <div className="sheet-danger">
          <Button variant="destructive" icon="trash" onClick={() => onDelete(folder)}>Удалить папку</Button>
          <p className="muted">Хосты и подпапки переедут на уровень выше.</p>
        </div>
      )}
    </Sheet>
  )
}
