import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react'
import { effectiveSettings, folderChain, INHERIT_LABEL, ownFields, resolveLogin } from '@shared/inherit'
import { hostAddresses, type Folder, type Host, type HostStatus, type StoreSnapshot } from '@shared/types'
import { Badge, Button, EmptyState, HealthDot, IconButton, MenuButton, openContextMenu, SearchField, Sparkline, StatusDot, Tile, type MenuItem } from '../design/components'
import { Icon } from '../design/icons'
import { dropTarget, startDrag, type MoveItems } from '../dnd'
import { addressAlive, folderPath, formatRtt, formatUptime, health, healthSummary, hostIcon, hostSearchText, hostsInSubtree, hostTint, kindMeta, perAddress, preferredAddress, subtreeIds } from '../util'

interface Props {
  store: StoreSnapshot
  status: Map<string, HostStatus>
  folderId: string | null
  onOpenFolder(id: string | null): void
  /** "Назад": the folder opened before this one, else one level up. Absent at the top with nothing to go back to. */
  onBack?(): void
  /** hostId → number of open sessions, for the session dot. */
  openCount: Map<string, number>
  connecting: Set<string>
  /** address: one of the host's addresses; none = the first that answers. */
  onConnect(hostId: string, address?: string): void
  onConnectFolder(folderId: string): void
  onEditHost(host: Host | null): void
  /** New host in this folder (null: top level). */
  onNewHost(folderId: string | null): void
  onEditFolder(folder: Folder | null, parentId?: string | null): void
  onDeleteHost(host: Host): void
  onDeleteFolder(folder: Folder): void
  /** Picked hosts and folders, folders with everything inside. */
  onDeleteItems(hostIds: string[], folderIds: string[]): void
  onBrowser(hostId: string, address?: string): void
  onWinbox(hostId: string, address?: string): void
  onTools?(hostId: string, address?: string): void
  /** Several hosts at once, side by side and grouped for broadcast. */
  onConnectMany(hostIds: string[]): void
  /** Icon and colour for everything picked with Ctrl + click. */
  onAppearance(folderIds: string[], hostIds: string[]): void
  /** Drag and drop onto a folder card or a breadcrumb. */
  onMove: MoveItems
  /** Drop own connection settings and take them from the folders again. */
  onInherit(hostIds: string[], folderIds: string[]): void
  /** New workspace from these hosts. */
  onNewWorkspace(hostIds: string[]): void
}

export function HostsScreen(p: Props) {
  const { store, folderId, status } = p
  const [query, setQuery] = useState('')
  const current = store.folders.find((f) => f.id === folderId) ?? null
  const crumbs = folderChain(store.folders, folderId)

  const q = query.trim().toLowerCase()
  const folders = useMemo(() => (q ? [] : store.folders.filter((f) => f.parentId === folderId)), [store, folderId, q])
  const hosts = useMemo(() => {
    if (!q) return store.hosts.filter((h) => h.folderId === folderId)
    // Search covers the current folder and everything below it.
    const scope = folderId ? subtreeIds(store.folders, folderId) : null
    return store.hosts.filter(
      (h) => (!scope || (h.folderId && scope.has(h.folderId))) && hostSearchText(h).includes(q)
    )
  }, [store, folderId, q])

  // Ctrl + click picks cards instead of opening them; "f:" folders, "h:" hosts.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => setPicked(new Set()), [folderId])
  const pickedFolders = folders.filter((f) => picked.has(`f:${f.id}`)).map((f) => f.id)
  const pickedHosts = hosts.filter((h) => picked.has(`h:${h.id}`)).map((h) => h.id)
  const pickCount = pickedFolders.length + pickedHosts.length
  /** True when the click was a Ctrl + click and only toggled the pick. */
  const togglePick = (e: MouseEvent, key: string) => {
    if (!e.ctrlKey && !e.metaKey) return false
    e.preventDefault()
    setPicked((cur) => {
      const next = new Set(cur)
      if (!next.delete(key)) next.add(key)
      return next
    })
    return true
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return
      if (e.key === 'Escape') setPicked(new Set())
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') {
        e.preventDefault()
        setPicked(new Set([...folders.map((f) => `f:${f.id}`), ...hosts.map((h) => `h:${h.id}`)]))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [folders, hosts])

  /** A search typed here is undone first, then the folder history. */
  const back = query ? () => setQuery('') : p.onBack
  // Alt + ← and the mouse's back button, like in Explorer.
  useEffect(() => {
    if (!back) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.altKey && e.key === 'ArrowLeft') || (e.target instanceof Element && e.target.closest('input, textarea, select, [role="dialog"]'))) return
      e.preventDefault()
      back()
    }
    const onMouse = (e: globalThis.MouseEvent) => {
      if (e.button !== 3 || (e.target instanceof Element && e.target.closest('[role="dialog"]'))) return
      e.preventDefault()
      back()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => (window.removeEventListener('keydown', onKey), window.removeEventListener('mouseup', onMouse))
  }, [back])

  // Dragging a picked card drags everything picked with it.
  const drag = (e: DragEvent, key: string) => startDrag(e, picked.has(key) ? [...picked] : [key])
  const [over, setOver] = useState<string | null | undefined>(undefined)
  const drop = (target: string | null) => dropTarget(target, p.onMove, setOver)
  const dropCls = (target: string | null) => (over === target ? 'is-drop-target' : '')

  /** Clicked host: highlighted; a double click connects. */
  const [focused, setFocused] = useState<string | null>(null)

  const hostMenu = (h: Host): MenuItem[] => {
    const s = effectiveSettings(store.folders, h)
    const st = status.get(h.id)
    const own = ownFields(h.id, h.overrides, store.secretIds)
    return [
      ...perAddress(h, st, { label: 'Подключиться', icon: 'terminal' }, (a) => p.onConnect(h.id, a)),
      ...perAddress(h, st, { label: 'Открыть в браузере', icon: 'globe' }, (a) => p.onBrowser(h.id, a)),
      ...(s.winbox ? perAddress(h, st, { label: 'Открыть в WinBox', icon: 'winbox' }, (a) => p.onWinbox(h.id, a)) : []),
      ...(p.onTools ? [{ label: 'Сетевые инструменты', icon: 'wrench' as const, onSelect: () => p.onTools!(h.id, preferredAddress(h, st)) }] : []),
      { label: 'Изменить', icon: 'pencil', sep: true, onSelect: () => p.onEditHost(h) },
      { label: 'Значок и цвет', icon: 'palette', onSelect: () => p.onAppearance([], [h.id]) },
      { label: 'В Workspace', icon: 'grid', onSelect: () => p.onNewWorkspace([h.id]) },
      ...(own.length && h.folderId ? [{ label: 'Взять настройки папки', icon: 'folder' as const, onSelect: () => p.onInherit([h.id], []) }] : []),
      { label: 'Удалить хост', icon: 'trash', destructive: true, sep: true, onSelect: () => p.onDeleteHost(h) }
    ]
  }
  const folderMenu = (f: Folder): MenuItem[] => [
    { label: 'Открыть', icon: 'folder', onSelect: () => p.onOpenFolder(f.id) },
    { label: 'Подключиться ко всем', icon: 'play', onSelect: () => p.onConnectFolder(f.id) },
    { label: 'Новая подпапка', icon: 'folder', sep: true, onSelect: () => p.onEditFolder(null, f.id) },
    { label: 'Новый хост здесь', icon: 'plus', onSelect: () => p.onNewHost(f.id) },
    { label: 'Изменить', icon: 'pencil', sep: true, onSelect: () => p.onEditFolder(f) },
    { label: 'Значок и цвет', icon: 'palette', onSelect: () => p.onAppearance([f.id], []) },
    { label: 'Удалить папку', icon: 'trash', destructive: true, sep: true, onSelect: () => p.onDeleteFolder(f) }
  ]
  /** Right click on one of several picked cards: the menu acts on all of them, like the pick bar. */
  const pickedMenu = (key: string): MenuItem[] | undefined => {
    if (pickCount < 2 || !picked.has(key)) return undefined
    return [
      ...(pickedHosts.length > 1 ? [{ label: `Подключиться к ${pickedHosts.length}`, icon: 'play' as const, onSelect: () => p.onConnectMany(pickedHosts) }] : []),
      ...(pickedHosts.length > 0 ? [{ label: 'В Workspace', icon: 'grid' as const, onSelect: () => p.onNewWorkspace(pickedHosts) }] : []),
      { label: 'Значок и цвет', icon: 'palette', onSelect: () => p.onAppearance(pickedFolders, pickedHosts) },
      { label: 'Настройки из папок', icon: 'folder', onSelect: () => (p.onInherit(pickedHosts, pickedFolders), setPicked(new Set())) },
      { label: `Удалить выбранные (${pickCount})`, icon: 'trash', destructive: true, sep: true, onSelect: () => p.onDeleteItems(pickedHosts, pickedFolders) }
    ]
  }
  const backgroundMenu: MenuItem[] = [
    { label: 'Новый хост', icon: 'plus', onSelect: () => p.onNewHost(folderId) },
    { label: current ? 'Новая подпапка' : 'Новая папка', icon: 'folder', onSelect: () => p.onEditFolder(null, folderId) },
    ...(current
      ? [
          { label: 'Подключиться ко всем', icon: 'play' as const, sep: true, onSelect: () => p.onConnectFolder(current.id) },
          { label: 'Изменить папку', icon: 'pencil' as const, onSelect: () => p.onEditFolder(current) }
        ]
      : [])
  ]

  const here = current ? hostsInSubtree(store, current.id).map((h) => h.id) : store.hosts.map((h) => h.id)
  const sum = healthSummary(here, status)

  return (
    <div className="screen">
      <div className="screen__bar drag">
        <IconButton icon="chevronLeft" label={query ? 'Назад: сбросить поиск (Alt + ←)' : 'Назад (Alt + ←)'} className="no-drag crumbs__back" disabled={!back} onClick={back} />
        {/* Breadcrumbs: Здание › Этаж › Серверная */}
        <nav className="crumbs no-drag" aria-label="Путь">
          <button className={`${!current ? 'is-current' : ''} ${dropCls(null)}`} onClick={() => p.onOpenFolder(null)} {...drop(null)}>Хосты</button>
          {crumbs.map((f) => (
            <span key={f.id} className="crumbs__item">
              <Icon name="chevronRight" size={12} />
              <button className={`${f.id === folderId ? 'is-current' : ''} ${dropCls(f.id)}`} onClick={() => p.onOpenFolder(f.id)} {...drop(f.id)}>
                <Icon name={kindMeta(f.kind).icon} size={14} />
                {f.name}
              </button>
            </span>
          ))}
        </nav>
        <span className="screen__spacer" />
        <div className="no-drag toolbar">
          <SearchField value={query} onChange={setQuery} placeholder={current ? `Поиск в «${current.name}»` : 'Поиск хостов'} />
          <Button variant="tinted" icon="folder" onClick={() => p.onEditFolder(null, folderId)}>{current ? 'Подпапка' : 'Папка'}</Button>
          <Button variant="filled" icon="plus" onClick={() => p.onEditHost(null)}>Хост</Button>
        </div>
      </div>

      <div className="screen__scroll" onContextMenu={(e) => openContextMenu(e, backgroundMenu, current?.name)} onClick={(e) => e.target === e.currentTarget && setFocused(null)}>
        <div className="screen__head">
          {current && <Tile tint={current.tint ?? 'gray'} icon={kindMeta(current.kind).icon} size="lg" />}
          <div>
            <h1>{current?.name ?? 'Хосты'}</h1>
            {here.length > 0 && (
              <div className="screen__sub">
                {current && <span>{kindMeta(current.kind).label} · </span>}
                <span className="ok">{sum.up} в сети</span>
                {sum.down > 0 && <span className="bad"> · {sum.down} недоступно</span>}
                {sum.unknown > 0 && <span> · {sum.unknown} не проверено</span>}
              </div>
            )}
          </div>
          {current && (
            <div className="screen__head-actions">
              <Button variant="tinted" size="sm" icon="play" onClick={() => p.onConnectFolder(current.id)}>
                Подключиться ко всем
              </Button>
              <IconButton icon="pencil" label="Изменить папку" onClick={() => p.onEditFolder(current)} />
            </div>
          )}
        </div>

        {folders.length > 0 && (
          <section className="cards-section">
            <h2>Папки</h2>
            <div className="cards cards--folders">
              {folders.map((f) => {
                const ids = hostsInSubtree(store, f.id).map((h) => h.id)
                const s = healthSummary(ids, status)
                const subCount = store.folders.filter((x) => x.parentId === f.id).length
                return (
                  <div key={f.id} className={`card ${picked.has(`f:${f.id}`) ? 'is-picked' : ''} ${dropCls(f.id)}`} onContextMenu={(e) => openContextMenu(e, pickedMenu(`f:${f.id}`) ?? folderMenu(f), f.name)} draggable onDragStart={(e) => drag(e, `f:${f.id}`)} {...drop(f.id)} role="button" tabIndex={0} aria-pressed={picked.has(`f:${f.id}`)} onClick={(e) => togglePick(e, `f:${f.id}`) || p.onOpenFolder(f.id)} onKeyDown={(e) => e.key === 'Enter' && p.onOpenFolder(f.id)}>
                    <Tile tint={f.tint ?? 'gray'} icon={kindMeta(f.kind).icon} />
                    <div className="card__text">
                      <div className="card__title">{f.name}</div>
                      <div className="card__sub">
                        {kindMeta(f.kind).label}
                        {subCount > 0 && ` · ${subCount} ${plural(subCount, 'подпапка', 'подпапки', 'подпапок')}`}
                        {` · ${ids.length} ${plural(ids.length, 'хост', 'хоста', 'хостов')}`}
                      </div>
                      {s.down > 0 && (
                        <div className="card__badges">
                          <Badge tint="red">{s.down} недоступно</Badge>
                        </div>
                      )}
                    </div>
                    {ids.length > 0 && <HealthDot health={s.down ? 'down' : s.up ? 'up' : 'unknown'} title={`${s.up} в сети, ${s.down} недоступно`} />}
                    <MenuButton items={folderMenu(f)} />
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {hosts.length > 0 && (
          <section className="cards-section">
            <h2>{q ? 'Найдено' : 'Хосты'}</h2>
            <div className="cards cards--hosts">
              {/* Column header of the Ferrum host table; hidden in Shellwise, where hosts are cards. */}
              <div className="cards__head" aria-hidden>
                <span className="cards__head-icon" />
                <span className="cards__cols"><span>Имя</span><span>Адрес</span><span>Состояние</span></span>
                <span className="cards__head-menu" />
              </div>
              {hosts.map((h) => {
                const s = effectiveSettings(store.folders, h)
                const st = status.get(h.id)
                const login = resolveLogin(store.folders, store.credentials, h, store.secretIds)
                const open = p.openCount.get(h.id) ?? 0
                const own = ownFields(h.id, h.overrides, store.secretIds)
                const addrs = hostAddresses(h)
                const pref = preferredAddress(h, st)
                return (
                  <div
                    key={h.id}
                    className={`card card--host ${picked.has(`h:${h.id}`) ? 'is-picked' : ''} ${focused === h.id ? 'is-focused' : ''}`}
                    draggable
                    onDragStart={(e) => drag(e, `h:${h.id}`)}
                    role="button"
                    tabIndex={0}
                    aria-pressed={picked.has(`h:${h.id}`)}
                    title="Двойной клик: подключиться · Ctrl + клик: выбрать · правый клик: меню"
                    onClick={(e) => togglePick(e, `h:${h.id}`) || setFocused(h.id)}
                    onDoubleClick={(e) => !e.ctrlKey && !e.metaKey && p.onConnect(h.id)}
                    onContextMenu={(e) => (setFocused(h.id), openContextMenu(e, pickedMenu(`h:${h.id}`) ?? hostMenu(h), h.name))}
                    onKeyDown={(e) => e.key === 'Enter' && p.onConnect(h.id)}
                  >
                    <div className="card__icon">
                      <Tile tint={hostTint(store, h)} icon={hostIcon(store, h)} />
                      <HealthDot health={health(st)} title={health(st) === 'down' ? 'Недоступен' : health(st) === 'up' ? 'В сети' : 'Не проверялся'} />
                    </div>
                    <div className="card__text">
                      <div className="card__title">
                        {h.name}
                        {p.connecting.has(h.id) ? <StatusDot state="connecting" /> : open > 0 && <Badge tint="green">SSH</Badge>}
                      </div>
                      <div className={`card__sub mono ${addrs.length > 1 ? 'card__sub--addrs' : ''}`}>
                        {login.username ? `${login.username}@` : ''}
                        {addrs.length < 2
                          ? h.address
                          : addrs.map((a, i) => {
                              const ok = addressAlive(st, a)
                              return (
                                <span key={a} className={['host-addr', a === pref && 'is-pref', ok === false && 'is-down'].filter(Boolean).join(' ')} title={`Адрес ${i + 1}${ok === undefined ? '' : ok ? ': отвечает' : ': не отвечает'}${a === pref ? '. По умолчанию подключение идёт сюда' : ''}`}>
                                  {a}
                                </span>
                              )
                            })}
                        {s.port !== 22 ? `:${s.port}` : ''}
                      </div>
                      <div className="card__metrics">
                        {st?.history.length ? (
                          <span className="metric" title={st.probe ? `Пинг: ${st.probe}, последние 30 проверок` : 'Ping, последние 30 проверок'}>
                            <Sparkline values={st.history} width={48} height={14} />
                            {st.alive ? formatRtt(st.rtt) : st.rtt === undefined && st.snmp?.ok ? 'ICMP закрыт' : 'нет ответа'}
                          </span>
                        ) : null}
                        {st?.snmp?.ok && st.snmp.temp !== undefined && (
                          <span className={`metric ${st.snmp.temp >= 70 ? 'bad' : st.snmp.temp >= 55 ? 'warn' : ''}`} title="Температура по SNMP">
                            <Icon name="thermometer" size={12} />
                            {Math.round(st.snmp.temp)}°
                          </span>
                        )}
                        {st?.snmp?.ok && st.snmp.uptime !== undefined && <span className="metric" title="Аптайм по SNMP">↑ {formatUptime(st.snmp.uptime)}</span>}
                        {st?.snmp?.ok && st.snmp.noTemp && (
                          <span className="metric dim" title="Устройство отвечает по SNMP, но не отдаёт температуру">
                            <Icon name="thermometer" size={12} />
                            нет данных
                          </span>
                        )}
                        {st?.snmp && !st.snmp.ok && (
                          <span className="metric dim" title={`${st.snmp.error ?? 'нет ответа'}${st.snmp.quiet ? '. Опрашивается реже, раз в 10 проверок, пока не ответит' : ''}`}>SNMP: нет данных</span>
                        )}
                        {s.algoProfile === 'legacy' && <Badge tint="orange">legacy</Badge>}
                        {login.source?.kind === 'credential' && <span className="metric" title="Вход по сохранённой учётке"><Icon name="key" size={12} />{login.source.name}</span>}
                        {own.length > 0 && h.folderId && (
                          <Badge tint="gray" title={`Задано у самого хоста, папка на это не действует: ${own.map((f) => INHERIT_LABEL[f]).join(', ')}`}>свои настройки</Badge>
                        )}
                      </div>
                      {q && h.folderId && <div className="card__path"><Icon name="folder" size={12} /> {folderPath(store.folders, h.folderId)}</div>}
                    </div>
                    <MenuButton items={hostMenu(h)} />
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {folders.length === 0 && hosts.length === 0 && (
          <EmptyState
            icon={q ? 'search' : current ? kindMeta(current.kind).icon : 'building'}
            title={q ? 'Ничего не найдено' : 'Здесь пока пусто'}
            message={
              q
                ? `Нет хостов с «${query}» в имени или адресе.`
                : 'Стройте дерево как в жизни: здание → этаж → серверная → кросс, а хосты кладите на нужный уровень. Логин, пароль и мониторинг задаются на папку и действуют на всё внутри.'
            }
            action={
              !q && (
                <div className="toolbar">
                  <Button variant="tinted" icon="folder" onClick={() => p.onEditFolder(null, folderId)}>{current ? 'Подпапка' : 'Папка'}</Button>
                  <Button variant="filled" icon="plus" onClick={() => p.onEditHost(null)}>Хост</Button>
                </div>
              )
            }
          />
        )}
      </div>

      {pickCount > 0 && (
        <div className="pick-bar" role="toolbar" aria-label="Выбранные">
          <span className="pick-bar__count">Выбрано: {pickCount}</span>
          <Button variant="filled" size="sm" icon="palette" onClick={() => p.onAppearance(pickedFolders, pickedHosts)}>Значок и цвет</Button>
          {pickedHosts.length > 1 && (
            <Button variant="tinted" size="sm" icon="play" onClick={() => p.onConnectMany(pickedHosts)}>Подключиться к {pickedHosts.length}</Button>
          )}
          {pickedHosts.length > 0 && (
            <Button variant="tinted" size="sm" icon="grid" onClick={() => p.onNewWorkspace(pickedHosts)}>В Workspace</Button>
          )}
          <Button variant="tinted" size="sm" icon="folder" onClick={() => (p.onInherit(pickedHosts, pickedFolders), setPicked(new Set()))}>Настройки из папок</Button>
          <Button variant="destructive" size="sm" icon="trash" onClick={() => p.onDeleteItems(pickedHosts, pickedFolders)}>Удалить</Button>
          <Button variant="plain" size="sm" onClick={() => setPicked(new Set())}>Снять выбор</Button>
        </div>
      )}
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
