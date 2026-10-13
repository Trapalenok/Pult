import { useState } from 'react'
import { effectiveSettings } from '@shared/inherit'
import type { Host, HostIcon, StoreSnapshot } from '@shared/types'
import { Button, Field, Group, Row, Sheet } from '../design/components'
import { folderPath, HOST_ICONS, newId } from '../util'
import { CommunityRow, connectionRows, FolderSelect, IconChoice, inheritedLogin, initialLogin, LoginRows, TintPicker, type LoginDraft } from './fields'

export interface SecretEdits {
  login: LoginDraft
  /** undefined = unchanged, null = remove, string = set. */
  community: string | null | undefined
}

interface Props {
  store: StoreSnapshot
  host: Host | null
  defaultFolderId: string | null
  onCancel(): void
  onSave(host: Host, secrets: SecretEdits): void
  onDelete(host: Host): void
}

export function HostSheet({ store, host, defaultFolderId, onCancel, onSave, onDelete }: Props) {
  const [draft, setDraft] = useState<Host>(host ?? { id: newId(), folderId: defaultFolderId, name: '', address: '', overrides: {} })
  const [login, setLogin] = useState<LoginDraft>(() => initialLogin(draft.id, draft.overrides, store.secretIds))
  const [community, setCommunity] = useState('')
  const [clearCommunity, setClearCommunity] = useState(false)

  // What the host gets from its folders if a field is left empty.
  const inherited = effectiveSettings(store.folders, { ...draft, overrides: {} })
  const rows = connectionRows({ value: draft.overrides, inherited, onChange: (overrides) => setDraft({ ...draft, overrides }) })
  const snmpOn = draft.overrides.snmp ?? inherited.snmp
  const valid = draft.address.trim().length > 0

  const save = () =>
    onSave(
      { ...draft, name: draft.name.trim() || draft.address.trim(), address: draft.address.trim() },
      { login, community: community ? community : clearCommunity ? null : undefined }
    )

  return (
    <Sheet title={host ? 'Изменить хост' : 'Новый хост'} onCancel={onCancel} onDone={save} doneDisabled={!valid} doneLabel={host ? 'Готово' : 'Сохранить'}>
      <Group>
        <Row label="Адрес">
          <Field autoFocus value={draft.address} placeholder="192.168.1.10 или sw-core.corp.local" onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
        </Row>
        <Row label="Название">
          <Field value={draft.name} placeholder={draft.address || 'sw-core-01'} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Row>
        {rows.port}
        <Row label="Папка" icon="folder" tint="gray">
          <FolderSelect folders={store.folders} value={draft.folderId} onChange={(folderId) => setDraft({ ...draft, folderId })} />
        </Row>
      </Group>

      <Group header="Учётные данные" footer="Выберите сохранённую учётку или введите логин и пароль. Пароли хранятся зашифрованными средствами Windows (DPAPI).">
        <LoginRows store={store} ownerId={draft.id} draft={login} onChange={setLogin} inherited={inheritedLogin(store, draft.folderId)} />
        <Row label="Ключ">
          <Field value={draft.privateKeyPath ?? ''} placeholder="C:\Users\…\.ssh\id_rsa (необязательно)" onChange={(e) => setDraft({ ...draft, privateKeyPath: e.target.value || undefined })} />
        </Row>
      </Group>

      <Group header="Подключение" footer="«Авто» подходит и для нового, и для старого оборудования: сначала современные алгоритмы, при отказе ssh-rsa, SHA-1 и CBC.">
        {rows.algo}
        {store.settings?.jump?.enabled && rows.jump}
      </Group>

      <Group header="Мониторинг" footer="Ping и SNMP (UDP 161) идут мимо SSH и не занимают VTY-линии. SNMP показывает имя, аптайм и температуру.">
        {rows.ping}
        {rows.snmp}
        {snmpOn && (
          <CommunityRow
            store={store}
            ownerId={draft.id}
            probe={{ ...draft }}
            value={community}
            cleared={clearCommunity}
            onChange={setCommunity}
            onClear={() => setClearCommunity(true)}
          />
        )}
      </Group>

      <Group header="Интеграции" footer="В веб-адресе можно использовать {address}, {port}, {name}.">
        {rows.web}
        {rows.winbox}
      </Group>

      <Group header="Значок и цвет" footer={draft.folderId ? `Без цвета берётся цвет папки «${folderPath(store.folders, draft.folderId)}». «Авто»: роутер для хостов с WinBox, иначе сервер.` : '«Авто»: роутер для хостов с WinBox, иначе сервер.'}>
        <Row
          label={
            <IconChoice<HostIcon | 'auto'>
              label="Значок"
              value={draft.icon ?? 'auto'}
              onChange={(icon) => setDraft({ ...draft, icon: icon === 'auto' ? undefined : icon })}
              options={[{ value: 'auto', label: 'Авто', icon: 'dash' }, ...HOST_ICONS.map((x) => ({ value: x.icon, label: x.label, icon: x.icon }))]}
            />
          }
        />
        <Row label={<TintPicker value={draft.tint} onChange={(tint) => setDraft({ ...draft, tint })} />} />
      </Group>

      {host && (
        <div className="sheet-danger">
          <Button variant="destructive" icon="trash" onClick={() => onDelete(host)}>Удалить хост</Button>
        </div>
      )}
    </Sheet>
  )
}
