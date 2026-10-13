import { useState } from 'react'
import { JUMP_DEFAULT_PORT, type AlgoProfile, type AppSettings, type Credential, type Folder, type ImportMode, type ImportPreview, type JumpHost, type JumpKind, type StoreSnapshot } from '@shared/types'
import { Button, Field, Group, Row, Segmented, Select, Toggle } from '../design/components'
import { THEMES, themeById } from '../design/themes'
import { TintPicker } from '../sheets/fields'
import { ALGO_LABEL, errorText, plural } from '../util'
import { ForeignImport } from './ForeignImport'

export function SettingsScreen({ settings, credentials, folders, onChange, onOpenCredentials, onImported }: {
  settings: AppSettings
  credentials: Credential[]
  folders: Folder[]
  onChange(s: AppSettings): void
  onOpenCredentials(): void
  onImported(s: StoreSnapshot): void
}) {
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => onChange({ ...settings, [k]: v })
  const jump = settings.jump ?? {}
  const setJump = (p: Partial<JumpHost>) => set('jump', { ...jump, ...p })
  const jumpKind: JumpKind = jump.kind ?? 'ssh'
  const socks = jumpKind === 'socks5'
  const current = themeById(settings.theme)
  return (
    <div className="screen">
      <div className="screen__bar drag" />
      <div className="screen__scroll narrow">
        <div className="screen__head">
          <h1>Настройки</h1>
        </div>

        <Group
          header="Jump-host"
          footer={
            (socks
              ? 'Все хосты, и уже созданные, и новые, подключаются через SOCKS5-прокси: вы → прокси → коммутатор. Через него идут SSH, веб-морда, WinBox и проверка портов в Инструментах. SNMP через SOCKS5 не проходит и идёт напрямую с этого компьютера. Папке или хосту можно выключить «Через jump-host», тогда они подключаются напрямую.'
              : 'Все хосты, и уже созданные, и новые, подключаются через этот сервер: вы → мастер-кей → коммутатор. На сервере нужен OpenSSH с AllowTcpForwarding yes. Веб-морда и WinBox тоже идут через него. SNMP идёт напрямую с этого компьютера. Папке или хосту можно выключить «Через jump-host», тогда они подключаются напрямую.') +
            (jump.pingVia
              ? ` Пинг через ${socks ? 'прокси' : 'jump-host'}: ICMP через ${socks ? 'SOCKS5' : 'SSH-туннель'} не проходит, поэтому ${socks ? 'прокси' : 'мастер-кей'} открывает TCP-подключение к SSH-порту хоста (обычно 22) и сразу закрывает его. Время включает путь до ${socks ? 'прокси' : 'мастер-кея'} и дальше до хоста. Ответ «порт закрыт» тоже значит «хост жив». Если SSH-порт хоста закрыт фильтром, будет «нет ответа», даже если обычный ping проходит.`
              : ' Пинг сейчас идёт напрямую с этого компьютера (обычный ICMP).')
          }
        >
          <Row label="Включён" icon="shield" tint="purple">
            <Toggle checked={!!jump.enabled} onChange={(enabled) => setJump({ enabled })} label="Jump-host" />
          </Row>
          {jump.enabled && (
            <>
              <Row label="Тип">
                <Segmented<JumpKind>
                  size="sm"
                  value={jumpKind}
                  onChange={(kind) => setJump({ kind })}
                  options={[
                    { value: 'ssh', label: 'SSH (мастер-кей)' },
                    { value: 'socks5', label: 'SOCKS5-прокси' }
                  ]}
                />
              </Row>
              <Row label="Адрес">
                <Field value={jump.address ?? ''} placeholder={socks ? '10.0.0.5 или proxy.corp.local' : '10.0.0.5 или masterkey.corp.local'} onChange={(e) => setJump({ address: e.target.value.trim() || undefined })} />
              </Row>
              <Row label="Порт">
                <Field inputMode="numeric" value={jump.port ?? ''} placeholder={String(JUMP_DEFAULT_PORT[jumpKind])} onChange={(e) => setJump({ port: Number(e.target.value.replace(/\D/g, '')) || undefined })} />
              </Row>
              <Row label={socks ? 'Логин и пароль' : 'Учётка'} icon="key" tint="indigo">
                {credentials.length ? (
                  <Select<string>
                    value={jump.credentialId ?? ''}
                    onChange={(v) => setJump({ credentialId: v || undefined })}
                    options={[{ value: '', label: socks ? 'Без авторизации' : 'Выберите учётку' }, ...credentials.map((c) => ({ value: c.id, label: c.name.includes(c.username) ? c.name : `${c.name} (${c.username})` }))]}
                  />
                ) : (
                  <Button variant="plain" size="sm" onClick={onOpenCredentials}>Добавить в «Учётных данных»</Button>
                )}
              </Row>
              <Row label="Пинг" icon="activity" tint="green">
                <Segmented<'direct' | 'jump'>
                  size="sm"
                  value={jump.pingVia ? 'jump' : 'direct'}
                  onChange={(v) => setJump({ pingVia: v === 'jump' })}
                  options={[
                    { value: 'direct', label: 'Напрямую (ICMP)' },
                    { value: 'jump', label: socks ? 'Через прокси (TCP)' : 'Через jump-host (TCP)' }
                  ]}
                />
              </Row>
              {!socks && (
                <Row label="Алгоритмы">
                  <Select<AlgoProfile>
                    value={jump.algoProfile ?? 'compat'}
                    onChange={(v) => setJump({ algoProfile: v })}
                    options={(['compat', 'modern', 'legacy'] as AlgoProfile[]).map((a) => ({ value: a, label: ALGO_LABEL[a] }))}
                  />
                </Row>
              )}
            </>
          )}
        </Group>

        <Group header="Тема">
          <div className="theme-grid" role="radiogroup" aria-label="Тема">
            {THEMES.map((t) => (
              <button key={t.id} role="radio" aria-checked={t.id === current.id} className={`theme-card ${t.id === current.id ? 'is-selected' : ''}`} onClick={() => set('theme', t.id)}>
                <span className="theme-card__preview" style={{ background: t.preview[0] }}>
                  <span style={{ background: t.preview[1] }} />
                  <span style={{ background: t.preview[1] }}>
                    <i style={{ background: t.preview[2] }} />
                    <i style={{ background: t.preview[2], opacity: 0.5 }} />
                  </span>
                </span>
                <span className="theme-card__name">{t.name}</span>
                <span className="theme-card__note">{t.note}</span>
              </button>
            ))}
          </div>
        </Group>

        <Group header="Акцент и терминал">
          <Row label="Акцентный цвет">
            {settings.accent ? <Button variant="plain" size="sm" onClick={() => set('accent', undefined)}>как в теме</Button> : <span>из темы {current.name}</span>}
          </Row>
          <Row label={<TintPicker value={settings.accent} onChange={(t) => set('accent', t)} />} />
          <Row label="Размер шрифта терминала">
            <Segmented
              size="sm"
              value={String(settings.termFontSize ?? 13)}
              onChange={(v) => set('termFontSize', Number(v))}
              options={['11', '12', '13', '14', '15', '16', '18'].map((v) => ({ value: v, label: v }))}
            />
          </Row>
        </Group>

        <Group header="Анимации" footer="Мигание портов на узлах карты и бегущий трафик по живым связям.">
          <Row label="Анимации на карте" icon="activity" tint="blue">
            <Toggle checked={settings.animations ?? true} onChange={(v) => set('animations', v)} label="Анимации" />
          </Row>
        </Group>

        <Group header="Мониторинг" footer={`Ping и SNMP опрашивают все хосты, где они включены. SSH-сессии и VTY-линии при этом не используются.${jump.enabled ? (jump.pingVia ? ' Пинг идёт через jump-host как TCP-проверка SSH-порта, SNMP — напрямую с этого компьютера.' : ' Опрос идёт напрямую с этого компьютера, не через jump-host.') : ''}`}>
          <Row label="Интервал проверки" icon="activity" tint="green">
            <Select<string>
              value={String(settings.monitorInterval ?? 30)}
              onChange={(v) => set('monitorInterval', Number(v))}
              options={[10, 15, 30, 60, 120, 300].map((s) => ({ value: String(s), label: s < 60 ? `${s} сек` : `${s / 60} мин` }))}
            />
          </Row>
        </Group>

        <Group header="WinBox" footer="WinBox открывается сразу с логином и паролем учётки хоста. Пароль при этом виден в командной строке процесса в диспетчере задач. Если выключить, WinBox откроется только с адресом и логином.">
          <Row label="Путь к winbox64.exe" icon="winbox" tint="teal">
            <Field value={settings.winboxPath ?? ''} placeholder="C:\Program Files\MikroTik\winbox64.exe" onChange={(e) => set('winboxPath', e.target.value || undefined)} />
          </Row>
          <Row label="Передавать пароль">
            <Toggle checked={settings.winboxPassPassword !== false} onChange={(v) => set('winboxPassPassword', v)} label="Передавать пароль" />
          </Row>
        </Group>

        <Group header="Терминал" footer="Выделение копирует текст, правый клик вставляет.">
          <Row label="Буфер прокрутки" detail="10 000 строк" />
        </Group>

        <ConfigTransfer onImported={onImported} />
        <ForeignImport folders={folders} onImported={onImported} />
      </div>
    </div>
  )
}

/** Export to one JSON file and import from one, to move the base to another PC or a colleague. */
function ConfigTransfer({ onImported }: { onImported(s: StoreSnapshot): void }) {
  const [withSecrets, setWithSecrets] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  const [importPass, setImportPass] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const passProblem = !withSecrets ? null : pass.length < 6 ? 'Пароль файла: не короче 6 символов' : pass !== pass2 ? 'Пароли не совпадают' : null

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  const doExport = () =>
    act(async () => {
      const path = await window.api.exportConfig(withSecrets ? pass : undefined)
      if (!path) return
      setNote({ ok: true, text: `Сохранено: ${path}${withSecrets ? '. Пароли внутри, зашифрованы.' : '. Без паролей.'}` })
      setPass('')
      setPass2('')
    })

  const pick = () =>
    act(async () => {
      const p = await window.api.importPick()
      if (!p) return
      setPreview(p)
      setMode('merge')
      setImportPass('')
    })

  const apply = () =>
    act(async () => {
      if (!preview) return
      if (mode === 'replace' && !confirm('Заменить всю текущую базу содержимым файла? Хосты, папки, учётки и карта, которых нет в файле, будут удалены.')) return
      const s = await window.api.importApply(preview.token, mode, preview.hasSecrets && importPass ? importPass : undefined)
      onImported(s)
      const f = preview.fresh
      setNote({
        ok: true,
        text:
          mode === 'merge'
            ? `Добавлено: ${plural(f.hosts, 'хост', 'хоста', 'хостов')}, ${plural(f.folders, 'папка', 'папки', 'папок')}, ${plural(f.credentials, 'учётка', 'учётки', 'учёток')}, ${plural(f.maps, 'лист', 'листа', 'листов')} карты. Существующие не изменены.`
            : 'База заменена содержимым файла.'
      })
      setPreview(null)
    })

  const c = preview?.counts
  return (
    <>
      <Group
        header="Перенос конфигурации"
        footer="Один JSON-файл со всей базой: папки, хосты, учётки, карта, настройки и доверенные ключи хостов. Пароли и SNMP-community на этом ПК зашифрованы под вашу учётку Windows, поэтому в файл они попадают только с паролем файла, а без него переносятся без паролей."
      >
        <Row label="Включить пароли" icon="key" tint="orange">
          <Toggle checked={withSecrets} onChange={setWithSecrets} label="Включить пароли" />
        </Row>
        {withSecrets && (
          <>
            <Row label="Пароль файла">
              <Field type="password" value={pass} placeholder="не короче 6 символов" onChange={(e) => setPass(e.target.value)} />
            </Row>
            <Row label="Ещё раз">
              <Field type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </Row>
          </>
        )}
        <Row label={passProblem ?? 'Экспорт в файл'} icon="upload" tint="blue">
          <Button size="sm" disabled={busy || !!passProblem} onClick={doExport}>Экспорт…</Button>
        </Row>
        <Row label="Импорт из файла" icon="download" tint="green">
          <Button size="sm" disabled={busy} onClick={pick}>Импорт…</Button>
        </Row>
      </Group>

      {preview && c && (
        <Group
          header={`Импорт: ${preview.fileName}`}
          footer={
            mode === 'merge'
              ? 'Добавятся только записи, которых здесь ещё нет. Всё, что уже есть, и ваши настройки останутся как были.'
              : 'Текущая база будет удалена и заменена файлом, включая настройки. Доверенные ключи хостов этого ПК сохранятся.'
          }
        >
          {preview.exportedAt && <Row label="Создан" detail={new Date(preview.exportedAt).toLocaleString('ru-RU')} />}
          <Row label="Хосты" detail={`${c.hosts}, новых ${preview.fresh.hosts}`} />
          <Row label="Папки" detail={`${c.folders}, новых ${preview.fresh.folders}`} />
          <Row label="Учётные данные" detail={`${c.credentials}, новых ${preview.fresh.credentials}`} />
          <Row label="Листы карты" detail={`${c.maps}, новых ${preview.fresh.maps}`} />
          <Row label="Пароли" detail={preview.hasSecrets ? 'есть, зашифрованы' : 'нет в файле'} />
          {preview.hasSecrets && (
            <Row label="Пароль файла">
              <Field type="password" value={importPass} placeholder="пусто = без паролей" onChange={(e) => setImportPass(e.target.value)} />
            </Row>
          )}
          <Row label="Как импортировать">
            <Segmented<ImportMode>
              size="sm"
              value={mode}
              onChange={setMode}
              options={[{ value: 'merge', label: 'Добавить новое' }, { value: 'replace', label: 'Заменить всё' }]}
            />
          </Row>
          <Row label="">
            <Button variant="plain" size="sm" disabled={busy} onClick={() => setPreview(null)}>Отмена</Button>
            <Button size="sm" disabled={busy} onClick={apply}>Импортировать</Button>
          </Row>
        </Group>
      )}

      {note && (
        <Group>
          <Row label={note.text} icon={note.ok ? 'check' : 'alert'} tint={note.ok ? 'green' : 'red'} />
        </Group>
      )}
    </>
  )
}
