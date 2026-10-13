import { useState } from 'react'
import type { Credential, StoreSnapshot } from '@shared/types'
import { Button, Field, Group, Row, Sheet } from '../design/components'
import { newId } from '../util'

export function CredentialSheet({ store, credential, usedBy, onCancel, onSave, onDelete }: {
  store: StoreSnapshot
  credential: Credential | null
  usedBy: number
  onCancel(): void
  /** password: undefined = unchanged. */
  onSave(c: Credential, password: string | undefined): void
  onDelete(c: Credential): void
}) {
  const [draft, setDraft] = useState<Credential>(credential ?? { id: newId(), name: '', username: '' })
  const [password, setPassword] = useState('')
  const hasPassword = store.secretIds.includes(draft.id)
  const valid = draft.username.trim() && (hasPassword || password)
  return (
    <Sheet
      title={credential ? 'Учётка' : 'Новая учётка'}
      onCancel={onCancel}
      onDone={() => onSave({ ...draft, name: draft.name.trim() || draft.username.trim(), username: draft.username.trim() }, password || undefined)}
      doneDisabled={!valid}
      doneLabel={credential ? 'Готово' : 'Сохранить'}
    >
      <Group footer="Учётку можно выбрать в любом хосте или папке. Пароль поменяется сразу везде, где она выбрана.">
        <Row label="Название">
          <Field autoFocus value={draft.name} placeholder={draft.username || 'Сетевики (AD)'} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Row>
        <Row label="Пользователь">
          <Field value={draft.username} placeholder="admin" onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
        </Row>
        <Row label="Пароль" icon="lock" tint="gray">
          <Field type="password" autoComplete="new-password" value={password} placeholder={hasPassword ? '•••••••• сохранён' : 'обязательно'} onChange={(e) => setPassword(e.target.value)} />
        </Row>
      </Group>
      {credential && (
        <div className="sheet-danger">
          <Button variant="destructive" icon="trash" onClick={() => onDelete(credential)}>Удалить учётку</Button>
          {usedBy > 0 && <p className="muted">Используется в {usedBy} местах; там вход станет «как выше».</p>}
        </div>
      )}
    </Sheet>
  )
}
