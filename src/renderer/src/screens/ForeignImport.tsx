import { useEffect, useMemo, useState } from 'react'
import type { Folder, ForeignField, ForeignMapping, ForeignOptions, ForeignPlan, ForeignPreview, StoreSnapshot } from '@shared/types'
import { Button, Field, Group, Row, Segmented, Select } from '../design/components'
import { errorText, folderPath, plural } from '../util'

const FIELDS: { field: ForeignField; label: string }[] = [
  { field: 'address', label: 'Адрес (IP или имя)' },
  { field: 'name', label: 'Имя хоста' },
  { field: 'port', label: 'Порт' },
  { field: 'username', label: 'Логин' },
  { field: 'password', label: 'Пароль' },
  { field: 'folder', label: 'Папка / группа' },
  { field: 'protocol', label: 'Протокол' }
]

const FORMAT_LABEL: Record<ForeignPreview['format'], string> = { sqlite: 'база SQLite', csv: 'таблица CSV', json: 'JSON' }

/**
 * Hosts from another program's base: an SQLite file of a web SSH manager, a CSV, a JSON export.
 * Columns are guessed, the user fixes the mapping and sees what will be added before it is.
 */
export function ForeignImport({ folders, onImported }: { folders: Folder[]; onImported(s: StoreSnapshot): void }) {
  const [preview, setPreview] = useState<ForeignPreview | null>(null)
  const [table, setTable] = useState('')
  const [mapping, setMapping] = useState<ForeignMapping>({})
  const [target, setTarget] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [duplicates, setDuplicates] = useState<ForeignOptions['duplicates']>('skip')
  const [plan, setPlan] = useState<ForeignPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  // The result line goes away by itself, like the error toasts.
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 12000)
    return () => clearTimeout(t)
  }, [note])
  const [busy, setBusy] = useState(false)

  const t = preview?.tables.find((x) => x.name === table)
  const opts: ForeignOptions = useMemo(
    () => ({ table, mapping, targetFolderId: target || null, newFolder: newFolder.trim() || undefined, duplicates }),
    [table, mapping, target, newFolder, duplicates]
  )

  useEffect(() => {
    if (!preview) return
    let live = true
    window.api.foreignPlan(preview.token, opts).then(
      (p) => live && (setPlan(p), setPlanError(null)),
      (e) => live && (setPlan(null), setPlanError(errorText(e)))
    )
    return () => {
      live = false
    }
  }, [preview, opts])

  const pick = async () => {
    setBusy(true)
    setNote(null)
    try {
      const p = await window.api.foreignPick()
      if (!p) return
      setPreview(p)
      setTable(p.bestTable)
      setMapping(p.tables.find((x) => x.name === p.bestTable)?.guess ?? {})
      setTarget('')
      setNewFolder(p.fileName.replace(/\.[^.]+$/, ''))
      setDuplicates('skip')
    } catch (e) {
      setNote({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  const chooseTable = (name: string) => {
    setTable(name)
    setMapping(preview?.tables.find((x) => x.name === name)?.guess ?? {})
  }

  const apply = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const { snapshot, plan: done } = await window.api.foreignApply(preview.token, opts)
      onImported(snapshot)
      const extra = [done.folders && plural(done.folders, 'папка', 'папки', 'папок'), done.passwords && `паролей ${done.passwords}`].filter(Boolean)
      setNote({ ok: true, text: `Добавлено ${plural(done.hosts, 'хост', 'хоста', 'хостов')}${extra.length ? `, ${extra.join(', ')}` : ''}. Исходный файл не изменён.` })
      setPreview(null)
      setPlan(null)
    } catch (e) {
      setNote({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  const folderOptions = useMemo(
    () => [{ value: '', label: 'Верхний уровень' }, ...folders.map((f) => ({ value: f.id, label: folderPath(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label, 'ru'))],
    [folders]
  )
  const columnOptions = [{ value: '', label: '— не импортировать —' }, ...(t?.columns ?? []).map((c) => ({ value: c, label: c }))]

  return (
    <>
      <Group
        header="Импорт из другой базы"
        footer="Хосты из базы другой программы: файл SQLite (.sqlite, .db) веб-менеджера SSH, таблица CSV из Excel или JSON-экспорт. Колонки определяются сами, их можно поправить. Пароли сразу шифруются, файл только читается."
      >
        <Row label="Открыть базу или таблицу" icon="download" tint="teal">
          <Button size="sm" disabled={busy} onClick={pick}>Открыть…</Button>
        </Row>
      </Group>

      {preview && t && (
        <>
          <Group header={`${preview.fileName}: ${FORMAT_LABEL[preview.format]}`} footer={preview.tables.length > 1 ? 'Выбрана таблица, больше всего похожая на список хостов.' : undefined}>
            {preview.tables.length > 1 && (
              <Row label="Таблица">
                <Select value={table} onChange={chooseTable} options={preview.tables.map((x) => ({ value: x.name, label: `${x.name} (${x.rowCount})` }))} />
              </Row>
            )}
            <div className="fi-scroll">
              <table className="fi-table">
                <thead>
                  <tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                </thead>
                <tbody>
                  {t.sample.map((r, i) => (
                    <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Row label="Строк в таблице" detail={String(t.rowCount)} />
          </Group>

          <Group header="Какая колонка чем станет" footer="Если в колонке адреса записано admin@10.0.0.1:2222, логин и порт возьмутся оттуда. Папки вида «Офис/Этаж 2» станут вложенными, а номера папок найдутся в соседней таблице базы.">
            {FIELDS.map(({ field, label }) => (
              <Row key={field} label={label}>
                <Select value={mapping[field] ?? ''} options={columnOptions} onChange={(v) => setMapping((m) => ({ ...m, [field]: v || undefined }))} />
              </Row>
            ))}
          </Group>

          <Group header="Куда положить">
            <Row label="Папка" icon="folder" tint="blue">
              <Select value={target} options={folderOptions} onChange={setTarget} />
            </Row>
            <Row label="Новая папка внутри">
              <Field value={newFolder} placeholder="не создавать" onChange={(e) => setNewFolder(e.target.value)} />
            </Row>
            <Row label="Такой же адрес и порт уже есть">
              <Segmented<ForeignOptions['duplicates']>
                size="sm"
                value={duplicates}
                onChange={setDuplicates}
                options={[{ value: 'skip', label: 'Пропустить' }, { value: 'add', label: 'Добавить всё равно' }]}
              />
            </Row>
          </Group>

          {planError && (
            <Group>
              <Row label={planError} icon="alert" tint="red" />
            </Group>
          )}

          {plan && (
            <Group
              header="Будет добавлено"
              footer={plan.passwordsLookEncrypted ? 'Пароли в этой базе похожи на хеши или шифр той программы, а не на сами пароли. Подключиться с ними не получится; можно снять колонку пароля и задать пароли папкам или учёткам.' : undefined}
            >
              <Row label="Хостов" detail={`${plan.hosts} из ${plan.rows}`} />
              {plan.duplicates > 0 && <Row label="Уже есть, пропущены" detail={String(plan.duplicates)} />}
              {plan.notSsh > 0 && <Row label="Не SSH (RDP, VNC, Telnet), пропущены" detail={String(plan.notSsh)} />}
              {plan.noAddress > 0 && <Row label="Без адреса, пропущены" detail={String(plan.noAddress)} />}
              <Row label="Новых папок" detail={String(plan.folders)} />
              {plan.folderLookup && <Row label="Названия папок из таблицы" detail={plan.folderLookup} />}
              <Row label="Паролей" detail={plan.passwords ? `${plan.passwords}, будут зашифрованы` : 'нет'} icon={plan.passwordsLookEncrypted ? 'alert' : undefined} tint="orange" />
              {plan.sample.length > 0 && (
                <div className="fi-scroll">
                  <table className="fi-table">
                    <thead>
                      <tr><th>Имя</th><th>Адрес</th><th>Логин</th><th>Папка</th><th>Пароль</th></tr>
                    </thead>
                    <tbody>
                      {plan.sample.map((h, i) => (
                        <tr key={i}>
                          <td>{h.name}</td>
                          <td>{h.address}{h.port && h.port !== 22 ? `:${h.port}` : ''}</td>
                          <td>{h.username ?? ''}</td>
                          <td>{h.folder}</td>
                          <td>{h.password ? '••••••' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Row label="">
                <Button variant="plain" size="sm" disabled={busy} onClick={() => (setPreview(null), setPlan(null))}>Отмена</Button>
                <Button size="sm" disabled={busy || plan.hosts === 0} onClick={apply}>
                  Импортировать {plural(plan.hosts, 'хост', 'хоста', 'хостов')}
                </Button>
              </Row>
            </Group>
          )}
        </>
      )}

      {note && (
        <Group>
          <Row label={note.text} icon={note.ok ? 'check' : 'alert'} tint={note.ok ? 'green' : 'red'} />
        </Group>
      )}
    </>
  )
}
