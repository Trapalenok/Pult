import type { Credential, StoreSnapshot } from '@shared/types'
import { Button, EmptyState, Group, openContextMenu, Row } from '../design/components'

export function CredentialsScreen({ store, onEdit }: { store: StoreSnapshot; onEdit(c: Credential | null): void }) {
  const usage = (id: string) =>
    store.hosts.filter((h) => h.overrides.credentialId === id).length + store.folders.filter((f) => f.defaults.credentialId === id).length
  return (
    <div className="screen">
      <div className="screen__bar drag">
        <span className="screen__spacer" />
        <div className="no-drag toolbar">
          <Button variant="filled" icon="plus" onClick={() => onEdit(null)}>Учётка</Button>
        </div>
      </div>
      <div className="screen__scroll narrow">
        <div className="screen__head">
          <h1>Учётные данные</h1>
        </div>
        {store.credentials.length === 0 ? (
          <EmptyState
            icon="key"
            title="Нет сохранённых учёток"
            message="Сохраните логин и пароль один раз и выбирайте их в хостах и папках. Позже сюда же подключится группа учёток из AD."
            action={<Button variant="filled" icon="plus" onClick={() => onEdit(null)}>Новая учётка</Button>}
          />
        ) : (
          <Group footer="Пароли хранятся зашифрованными средствами Windows и не показываются в интерфейсе.">
            {store.credentials.map((c) => {
              const n = usage(c.id)
              return (
                <Row
                  key={c.id}
                  onContextMenu={(e) => openContextMenu(e, [
                    { label: 'Изменить', icon: 'pencil', onSelect: () => onEdit(c) },
                    { label: 'Новая учётка', icon: 'plus', onSelect: () => onEdit(null) }
                  ], c.name)}
                  label={c.name}
                  icon="key"
                  tint="indigo"
                  detail={
                    <>
                      <span className="mono">{c.username}</span>
                      {n > 0 && <span> · {n} {n === 1 ? 'место' : n < 5 ? 'места' : 'мест'}</span>}
                      {!store.secretIds.includes(c.id) && <span className="bad"> · нет пароля</span>}
                    </>
                  }
                  chevron
                  onClick={() => onEdit(c)}
                />
              )
            })}
          </Group>
        )}
      </div>
    </div>
  )
}
