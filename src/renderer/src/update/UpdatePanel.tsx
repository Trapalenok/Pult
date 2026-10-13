import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { compareVersions, releasesBetween, type ReleaseInfo, type UpdateState } from '@shared/update'
import { Banner, Button, Group, Row, Select, Toggle } from '../design/components'
import { errorText, plural } from '../util'

/** Update state from the main process, kept live. */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    let alive = true
    window.api.updateState().then((s) => alive && setState(s))
    const off = window.api.onUpdate(setState)
    return () => ((alive = false), off())
  }, [])
  return state
}

const DISMISSED = 'update.dismissed'

function dismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

/** "Доступна версия X" at the top of the window after the check at start. Closing hides it until the next version. */
export function UpdateBanner({ state, onOpen }: { state: UpdateState | null; onOpen(): void }) {
  const [hidden, setHidden] = useState(dismissed)
  const v = state?.available
  if (!state || !v || hidden === v) return null
  const close = () => {
    try {
      localStorage.setItem(DISMISSED, v)
    } catch {
      /* private storage off: the banner just comes back next start */
    }
    setHidden(v)
  }
  const fresh = releasesBetween(state.releases, state.current, v)
  return (
    <div className="toast-area">
      <Banner tint="blue" title={`Доступна версия Pult ${v}`} onClose={close}>
        <div className="update-banner">
          <span>
            У вас {state.current}{fresh.length > 1 ? `, с тех пор ${plural(fresh.length, 'релиз', 'релиза', 'релизов')}` : ''}. Что нового и установка: в Настройках.
          </span>
          <Button size="sm" onClick={() => (onOpen(), close())}>Подробнее</Button>
        </div>
      </Banner>
    </div>
  )
}

const KIND_LABEL = { setup: 'установлена', portable: 'portable', dev: 'из исходников' } as const

/** Settings → Обновления: check, pick any version, read what's new, download and install. */
export function UpdateGroup({ state, checkAtStart, onCheckAtStart }: { state: UpdateState | null; checkAtStart: boolean; onCheckAtStart(v: boolean): void }) {
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!state) return null

  const installable = state.releases.filter((r) => r.asset)
  const target = picked ?? state.available ?? state.ready ?? state.current
  const rel = state.releases.find((r) => r.version === target)
  const cmp = compareVersions(target, state.current)
  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'installing'
  const notes = cmp > 0 ? releasesBetween(state.releases, state.current, target) : rel ? [rel] : []

  const act = (p: Promise<unknown>) => {
    setError(null)
    p.catch((e) => setError(errorText(e)))
  }

  const status =
    state.phase === 'checking'
      ? 'Проверяю…'
      : !state.checkedAt
        ? 'Ещё не проверялось'
        : state.available
          ? `Есть новая версия: ${state.available}`
          : `Последняя версия, проверено ${new Date(state.checkedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`

  const footer =
    state.kind === 'dev'
      ? 'Pult запущен из исходников: список релизов виден, а обновляется он через git pull.'
      : cmp < 0
        ? `Откат на ${target}: настройки и хосты сохранятся, но то, чего в ${target} ещё не было, она не покажет. Открытые сессии закроются.`
        : state.kind === 'portable'
          ? 'Новая portable-версия ляжет рядом с текущим exe и запустится вместо неё. База хостов общая и не меняется.'
          : 'Установщик ставит новую версию поверх текущей в ту же папку, Pult закрывается и запускается снова. Открытые сессии закроются, база хостов в %APPDATA%\\ssh-client не меняется.'

  const verb = cmp > 0 ? `Обновить до ${target}` : cmp < 0 ? `Откатить на ${target}` : null
  const options = (installable.some((r) => r.version === state.current) ? installable : [...installable, { version: state.current } as ReleaseInfo]).map((r) => ({
    value: r.version,
    label: r.version + (r.version === state.current ? ' (текущая)' : r.version === state.releases[0]?.version ? ' (последняя)' : '')
  }))

  return (
    <Group header="Обновления" footer={state.releases.length ? footer : `Релизы берутся со страницы github.com/Trapalenok/Pult/releases. Нужен доступ в интернет с этого компьютера.`}>
      <Row label="Текущая версия" icon="download" tint="blue" detail={`${state.current}, ${KIND_LABEL[state.kind]}`} />
      <Row label="Проверять при запуске">
        <Toggle checked={checkAtStart} onChange={onCheckAtStart} label="Проверять при запуске" />
      </Row>
      <Row label={status}>
        <Button size="sm" disabled={busy} onClick={() => act(window.api.updateCheck())}>Проверить</Button>
      </Row>

      {state.releases.length > 0 && (
        <>
          <Row label="Версия">
            <Select<string> value={target} onChange={setPicked} options={options} />
          </Row>
          {notes.length > 0 && (
            <div className="update-notes">
              {notes.map((r) => (
                <section key={r.version}>
                  <h5>
                    {r.name}
                    {r.publishedAt && <span>{new Date(r.publishedAt).toLocaleDateString('ru-RU')}</span>}
                  </h5>
                  <Notes text={r.notes} />
                </section>
              ))}
            </div>
          )}
          {state.kind !== 'dev' && verb && (
            <Row label={progressLabel(state, target) ?? verb}>
              {state.phase === 'downloading' ? (
                <>
                  <progress className="update-progress" value={state.progress ?? 0} max={1} />
                  <Button variant="plain" size="sm" onClick={() => window.api.updateCancel()}>Отмена</Button>
                </>
              ) : state.phase === 'downloaded' && state.ready === target ? (
                <Button size="sm" variant="filled" onClick={() => act(window.api.updateInstall())}>Установить и перезапустить</Button>
              ) : (
                <Button size="sm" disabled={busy || !rel?.asset} onClick={() => act(window.api.updateDownload(target))}>
                  {rel?.asset ? `Скачать${rel.asset.size ? `, ${Math.round(rel.asset.size / 1048576)} МБ` : ''}` : 'Нет файла'}
                </Button>
              )}
            </Row>
          )}
        </>
      )}

      {(error || state.error) && <Row label={error ?? state.error} icon="alert" tint="red" />}
    </Group>
  )
}

function progressLabel(s: UpdateState, target: string): string | null {
  if (s.phase === 'downloading') return `Скачиваю ${target}: ${Math.round((s.progress ?? 0) * 100)}%`
  if (s.phase === 'installing') return 'Запускаю установку…'
  if (s.phase === 'downloaded' && s.ready === target) return `${target} скачана и проверена`
  return null
}

/**
 * Release notes: the "Что нового" list when the release has one (the rest is download advice
 * for the release page), otherwise the whole text. Just enough Markdown for our notes.
 */
function Notes({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((l) => /что нового/i.test(l) && /^(#|\*\*)/.test(l.trim()))
  let body = lines
  if (start >= 0) {
    let end = start + 1
    while (end < lines.length && (!lines[end].trim() || /^\s*[-*] /.test(lines[end]))) end++
    body = lines.slice(start + 1, end)
  }
  const blocks: ReactNode[] = []
  let list: string[] = []
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>)
    list = []
  }
  for (const raw of body) {
    const l = raw.trim()
    if (/^[-*] /.test(l)) list.push(l.slice(2))
    else {
      flush()
      if (!l) continue
      const head = l.match(/^#+\s*(.*)$/) ?? l.match(/^\*\*([^*]+)\*\*$/)
      blocks.push(head ? <strong key={blocks.length}>{head[1]}</strong> : <p key={blocks.length}>{inline(l)}</p>)
    }
  }
  flush()
  return blocks.length ? <>{blocks}</> : <p className="update-notes__empty">Без описания.</p>
}

function inline(s: string): ReactNode {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
}
