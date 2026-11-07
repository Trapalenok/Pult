import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { snmpSecretId, type AppSettings, type Credential, type Folder, type Host, type HostKeyPrompt, type HostStatus, type NetMap, type StoreSnapshot, type Workspace } from '@shared/types'
import { Badge, Banner, ContextMenuHost, HealthDot, IconButton, openContextMenu, type MenuItem } from './design/components'
import { dropTarget, type MoveItems } from './dnd'
import { Icon, type IconName } from './design/icons'
import { applyTheme, designOf, themeById } from './design/themes'
import { MapScreen } from './map/MapScreen'
import { CredentialsScreen } from './screens/CredentialsScreen'
import { HostsScreen } from './screens/HostsScreen'
import { groupKey, SessionsScreen, visibleSessions, type Layout, type SessionGroup } from './screens/SessionsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ToolsScreen, type ToolsTarget } from './screens/ToolsScreen'
import { AppearanceSheet, applyAppearance } from './sheets/AppearanceSheet'
import { CredentialSheet } from './sheets/CredentialSheet'
import type { LoginDraft } from './sheets/fields'
import { FolderSheet } from './sheets/FolderSheet'
import { HostKeySheet } from './sheets/HostKeySheet'
import { HostSheet, type SecretEdits } from './sheets/HostSheet'
import type { PaneSession } from './terminal/TerminalPane'
import { WorkspaceSheet } from './sheets/WorkspaceSheet'
import { closedNotice, noticeToTerminal, writeToTerminal } from './terminal/TerminalView'
import { ask, choose, ConfirmHost } from './design/confirm'
import { contentsText, deletionScope, describeOwn, errorText, healthSummary, hostsInSubtree, hostTint, inheritFromFolders, kindMeta, moveInto, newId, ownSummary, plural, removeItems, subtreeIds } from './util'

const DEL = { ok: 'Удалить', destructive: true }

type Screen = 'hosts' | 'sessions' | 'map' | 'tools' | 'credentials' | 'settings'
type Editing =
  | { kind: 'host'; host: Host | null; folderId?: string | null }
  | { kind: 'folder'; folder: Folder | null; parentId: string | null }
  | { kind: 'credential'; credential: Credential | null }
  | { kind: 'appearance'; folderIds: string[]; hostIds: string[] }
  | { kind: 'workspace'; workspace: Workspace | null; hostIds?: string[]; name?: string; groupId?: string }
  | null

export function App() {
  const [store, setStore] = useState<StoreSnapshot | null>(null)
  const [screen, setScreen] = useState<Screen>('hosts')
  const [toolsTarget, setToolsTarget] = useState<ToolsTarget | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => void (screen === 'tools' && setToolsOpen(true)), [screen])
  const [folderId, setFolderId] = useState<string | null>(null)
  /** Folders opened before the current one, for "Назад" on the hosts screen (null: the top level). */
  const [folderHistory, setFolderHistory] = useState<(string | null)[]>([])
  const [editing, setEditing] = useState<Editing>(null)
  const [error, setError] = useState<{ title: string; text: string } | null>(null)
  /** The pointer is on the error: it stays until the pointer leaves. */
  const [errorHeld, setErrorHeld] = useState(false)
  // Errors go away by themselves; a longer text stays longer.
  useEffect(() => {
    if (!error || errorHeld) return
    const t = setTimeout(() => setError(null), Math.min(15000, 6000 + (error.title.length + error.text.length) * 30))
    return () => clearTimeout(t)
  }, [error, errorHeld])
  const [status, setStatus] = useState<Map<string, HostStatus>>(new Map())
  const [keyPrompts, setKeyPrompts] = useState<HostKeyPrompt[]>([])
  /** Set by "Доверять всем новым" until every pending connection is through. */
  const trustNewRef = useRef(false)

  const [sessions, setSessions] = useState<PaneSession[]>([])
  const [detached, setDetached] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<{ key: string; hostId: string; title: string; groupId?: string }[]>([])
  /** Focused session: where the keyboard goes. */
  const [active, setActive] = useState<string | null>(null)
  const [layout, setLayout] = useState<Layout>('tabs')
  /** Sessions opened together share one tab; `tabs` holds tab keys in the order they were opened. */
  const [groups, setGroups] = useState<SessionGroup[]>([])
  const [tabs, setTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  /** Groups closed while some of their sessions were still connecting: those are hung up on arrival. */
  const closedGroups = useRef(new Set<string>())
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  /** Sidebar folder under a dragged host. */
  const [dropOver, setDropOver] = useState<string | null | undefined>(undefined)
  const [group, setGroup] = useState<Set<string>>(new Set())
  /** Broadcast on (the button on the sessions screen): typing goes to every marked session on screen. */
  const [broadcast, setBroadcast] = useState(false)
  /** Sidebar folded to a strip of icons, for more room in a folder or on the map. Kept across restarts. */
  const [rail, setRail] = useState(() => loadFlag(RAIL_KEY))
  const toggleRail = () => setRail((r) => (saveFlag(RAIL_KEY, !r), !r))
  const [treeOpen, setTreeOpen] = useState<Set<string>>(loadTreeOpen)
  const toggleTreeFolder = useCallback((id: string) => {
    setTreeOpen((o) => {
      const next = o.has(id) ? without(o, id) : new Set(o).add(id)
      saveTreeOpen(next)
      return next
    })
  }, [])
  const groupRef = useRef(group)
  groupRef.current = group

  useEffect(() => {
    window.api.loadStore().then((s) => (setStore(s), applyTheme(s.settings)))
    window.api.monitorAll().then((all) => setStatus(new Map(all.map((s) => [s.hostId, s]))))
    const offMonitor = window.api.onMonitor((changed) =>
      setStatus((m) => {
        const n = new Map(m)
        changed.forEach((s) => n.set(s.hostId, s))
        return n
      })
    )
    const offKey = window.api.onHostKeyPrompt((p) => {
      // "Доверять всем новым" holds for the rest of the pack being opened: hosts still in the queue don't ask again.
      if (trustNewRef.current && !p.previous) return window.api.answerHostKey(p.requestId, true)
      setKeyPrompts((q) => [...q, p])
    })
    const offKeyCancel = window.api.onHostKeyCancel((id) => setKeyPrompts((q) => q.filter((p) => p.requestId !== id)))
    const offStore = window.api.onStoreChanged(setStore)
    const offData = window.api.onData(writeToTerminal)
    const offClosed = window.api.onClosed((id, reason) => {
      noticeToTerminal(id, closedNotice(reason))
      setSessions((s) => s.map((x) => (x.sessionId === id ? { ...x, closed: reason } : x)))
      setGroup((g) => without(g, id))
    })
    const offReturned = window.api.onReturned((s) => {
      setDetached((d) => without(d, s.sessionId))
      setActive(s.sessionId)
      const groupId = sessionsRef.current.find((x) => x.sessionId === s.sessionId)?.groupId
      setActiveTab(groupId ? groupKey(groupId) : s.sessionId)
    })
    return () => (offMonitor(), offKey(), offKeyCancel(), offStore(), offData(), offClosed(), offReturned())
  }, [])

  // Once React has committed the first screen with the base, the start-up logo window gives way to this one.
  // An effect, not a timer or requestAnimationFrame: the window is still hidden, and Chromium holds both back there.
  const loaded = store !== null
  useEffect(() => void (loaded && window.api.ready()), [loaded])

  const save = async (next: StoreSnapshot) => {
    // Shown at once: until the main process answers, a status update would otherwise
    // re-render from the old store and throw a just-dragged node back for a moment.
    setStore(next)
    const saved = await window.api.saveStore(next)
    setStore(saved)
    return saved
  }

  /* ── Connecting ─────────────────────────────────────────── */

  /**
   * One session. Without a group it gets a tab of its own and errors show at once; in a group it
   * goes into the group's tab and connectMany reports the errors together. Returns the session id,
   * or the error.
   */
  const connect = useCallback(
    async (hostId: string, groupId?: string, address?: string): Promise<string | Error | null> => {
      const host = store?.hosts.find((h) => h.id === hostId)
      if (!host) return null
      const key = crypto.randomUUID()
      setPending((p) => [...p, { key, hostId, title: host.name, groupId }])
      setScreen('sessions')
      try {
        const s = await window.api.connect(hostId, 120, 32, address)
        if (groupId && closedGroups.current.has(groupId)) {
          window.api.close(s.sessionId)
          return null
        }
        setSessions((x) => [...x, { ...s, groupId }])
        if (!groupId) {
          setTabs((t) => [...t, s.sessionId])
          setActiveTab(s.sessionId)
          setActive(s.sessionId)
        } else setActive((a) => (a && sessionsRef.current.some((x) => x.sessionId === a && x.groupId === groupId) ? a : s.sessionId))
        return s.sessionId
      } catch (e) {
        if (!groupId) setError({ title: `Не удалось подключиться к ${host.name}`, text: errorText(e) })
        return e instanceof Error ? e : new Error(String(e))
      } finally {
        setPending((p) => p.filter((x) => x.key !== key))
      }
    },
    [store]
  )

  /**
   * Several hosts at once (a workspace, a folder, a map sheet, picked cards): one tab named `title`
   * with all of them in a grid, marked for broadcast. Errors are collected into one message.
   */
  const connectMany = async (hostIds: string[], title: string, workspaceId?: string) => {
    if (hostIds.length === 0) return
    if (hostIds.length === 1 && !workspaceId) return void connect(hostIds[0])
    const g: SessionGroup = { id: newId(), title, workspaceId }
    setGroups((x) => [...x, g])
    setTabs((t) => [...t, groupKey(g.id)])
    setActiveTab(groupKey(g.id))
    setLayout('tabs')
    setScreen('sessions')
    const failed: string[] = []
    // Each session joins the broadcast group as soon as it is up: one unreachable host must not hold the rest back.
    await Promise.all(hostIds.map(async (h) => {
      const r = await connect(h, g.id)
      if (typeof r === 'string') setGroup((gr) => new Set([...gr, r]))
      else if (r instanceof Error) failed.push(`${store?.hosts.find((x) => x.id === h)?.name ?? h}: ${errorText(r)}`)
    }))
    if (failed.length) setError({ title: `«${title}»: не подключились ${failed.length} из ${hostIds.length}`, text: failed.join('\n') })
  }

  // A group whose sessions are all gone (closed, or none connected) loses its tab.
  useEffect(() => {
    const empty = new Set(groups.filter((g) => !sessions.some((s) => s.groupId === g.id) && !pending.some((x) => x.groupId === g.id)).map((g) => g.id))
    if (!empty.size) return
    setGroups((gs) => gs.filter((g) => !empty.has(g.id)))
    setTabs((t) => t.filter((k) => !(k.startsWith('g:') && empty.has(k.slice(2)))))
  }, [groups, sessions, pending])

  const attachedIds = sessions.filter((s) => !detached.has(s.sessionId)).map((s) => s.sessionId)
  const liveTabs = tabs.filter((k) => (k.startsWith('g:') ? groups.some((g) => groupKey(g.id) === k) : attachedIds.includes(k)))
  // The active tab closed or went to its own window: show the last one opened.
  useEffect(() => {
    if (activeTab === null ? liveTabs.length > 0 : !liveTabs.includes(activeTab)) setActiveTab(liveTabs.at(-1) ?? null)
  }, [liveTabs.join('|'), activeTab])

  const openWorkspace = (w: Workspace) => {
    const open = groups.find((g) => g.workspaceId === w.id)
    if (open) {
      setActiveTab(groupKey(open.id))
      setLayout('tabs')
      setScreen('sessions')
      return
    }
    const ids = w.hostIds.filter((id) => store?.hosts.some((h) => h.id === id))
    if (!ids.length) return setError({ title: `В Workspace «${w.name}» нет хостов`, text: 'Хосты из него удалены. Откройте его настройки и выберите хосты заново.' })
    connectMany(ids, w.name, w.id)
  }

  const answerKey = (accept: boolean) => {
    const [first, ...rest] = keyPrompts
    if (!first) return
    window.api.answerHostKey(first.requestId, accept)
    setKeyPrompts(rest)
  }

  useEffect(() => {
    if (!pending.length) trustNewRef.current = false
  }, [pending.length])

  const trustAllNew = () => {
    trustNewRef.current = pending.length > 0
    keyPrompts.filter((p) => !p.previous).forEach((p) => window.api.answerHostKey(p.requestId, true))
    setKeyPrompts((q) => q.filter((p) => p.previous))
  }

  const attached = sessions.filter((s) => !detached.has(s.sessionId))
  /** Broadcast never reaches sessions that are not on screen. */
  const onScreen = new Set(visibleSessions(attached, activeTab, layout).map((s) => s.sessionId))
  const onInput = (sessionId: string, data: string) => {
    // Enter in a closed session's terminal connects it again, like the button in its header.
    if (data === '\r' && sessionsRef.current.find((x) => x.sessionId === sessionId)?.closed) return void reconnect(sessionId)
    const g = groupRef.current
    if (broadcast && g.has(sessionId) && onScreen.has(sessionId)) window.api.broadcast([...g].filter((id) => onScreen.has(id)), data)
    else window.api.write(sessionId, data)
  }

  /** Sessions with a reconnect on its way: a second Enter or click waits for the first. */
  const reconnectingRef = useRef(new Set<string>())
  const reconnectAttemptsRef = useRef(new Map<string, number>())
  /** The same session, same pane, same tab and group: only the connection behind it is new. */
  const reconnect = async (id: string) => {
    const s = sessionsRef.current.find((x) => x.sessionId === id)
    if (!s?.closed || reconnectingRef.current.has(id)) return
    reconnectingRef.current.add(id)
    const mark = (patch: Partial<PaneSession>) => setSessions((x) => x.map((y) => (y.sessionId === id ? { ...y, ...patch } : y)))
    mark({ reconnecting: true })
    noticeToTerminal(id, `\x1b[36m[переподключение к ${s.address ?? s.title}…]\x1b[0m\r\n`)
    try {
      const r = await window.api.reconnect(id, s.hostId, s.address)
      reconnectAttemptsRef.current.delete(id)
      mark({ closed: undefined, reconnecting: false, address: r.address })
    } catch (e) {
      mark({ reconnecting: false })
      noticeToTerminal(id, `\x1b[31m[не удалось: ${errorText(e).replace(/\n/g, '\r\n')}]\x1b[0m\r\n\x1b[2mEnter или «Переподключить»: попробовать ещё раз\x1b[0m\r\n`)
    } finally {
      reconnectingRef.current.delete(id)
    }
  }

  // A dropped SSH transport is commonly a device-side idle timer. Keep the pane and retry
  // the handshake automatically; slow the retries down while the device is unavailable.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const s of sessions) {
      if (!s.closed || s.reconnecting || reconnectingRef.current.has(s.sessionId)) continue
      const attempt = reconnectAttemptsRef.current.get(s.sessionId) ?? 0
      const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempt, 4))
      timers.push(setTimeout(() => {
        reconnectAttemptsRef.current.set(s.sessionId, attempt + 1)
        void reconnect(s.sessionId)
      }, delay))
    }
    return () => timers.forEach(clearTimeout)
  }, [sessions])

  const closeSession = (id: string) => {
    reconnectAttemptsRef.current.delete(id)
    window.api.close(id)
    setSessions((s) => {
      const rest = s.filter((x) => x.sessionId !== id)
      if (active === id) setActive(rest.at(-1)?.sessionId ?? null)
      return rest
    })
    setTabs((t) => t.filter((k) => k !== id))
    setGroup((g) => without(g, id))
  }

  /** Closes a tab: one session, or every session of a group (asked first when there are several). */
  const closeTab = async (key: string) => {
    if (!key.startsWith('g:')) return closeSession(key)
    const g = groups.find((x) => groupKey(x.id) === key)
    if (!g) return
    const members = sessions.filter((s) => s.groupId === g.id)
    const live = members.filter((s) => !s.closed).length
    if (live > 1 && !(await ask(`Закрыть «${g.title}»: ${live} сессий?`, { ok: 'Закрыть', destructive: true }))) return
    closedGroups.current.add(g.id)
    members.forEach((s) => window.api.close(s.sessionId))
    const ids = new Set(members.map((s) => s.sessionId))
    setSessions((s) => s.filter((x) => !ids.has(x.sessionId)))
    setGroup((gr) => new Set([...gr].filter((id) => !ids.has(id))))
    setGroups((gs) => gs.filter((x) => x.id !== g.id))
    setTabs((t) => t.filter((k) => k !== key))
  }

  const popout = (s: PaneSession) => {
    setDetached((d) => new Set(d).add(s.sessionId))
    setGroup((g) => without(g, s.sessionId))
    window.api.popout({ sessionId: s.sessionId, hostId: s.hostId, title: s.title, address: s.address })
  }

  /* ── Saving hosts, folders, accounts ─────────────────────── */

  /**
   * Turns the login part of a sheet into: the defaults to store on the entity, plus secret writes.
   * "Save as account" creates a Credential and points the entity at it.
   */
  const applyLogin = (s: StoreSnapshot, ownerId: string, d: Host['overrides'], login: LoginDraft) => {
    const ops: [string, string | null][] = []
    const hadOwn = s.secretIds.includes(ownerId)
    let credentials = s.credentials
    let defaults = { ...d }
    if (login.mode === 'manual' && login.saveAs && login.username.trim() && login.password) {
      const c: Credential = { id: newId(), name: login.saveName.trim() || login.username.trim(), username: login.username.trim() }
      credentials = [...credentials, c]
      ops.push([c.id, login.password])
      defaults = { ...defaults, credentialId: c.id, username: undefined }
      if (hadOwn) ops.push([ownerId, null])
    } else if (login.mode === 'saved' && login.credentialId) {
      defaults = { ...defaults, credentialId: login.credentialId, username: undefined }
      if (hadOwn) ops.push([ownerId, null])
    } else if (login.mode === 'manual') {
      defaults = { ...defaults, credentialId: undefined, username: login.username.trim() || undefined }
      if (login.password) ops.push([ownerId, login.password])
      else if (login.clearPassword && hadOwn) ops.push([ownerId, null])
    } else {
      defaults = { ...defaults, credentialId: undefined, username: undefined }
      if (hadOwn) ops.push([ownerId, null])
    }
    return { defaults, credentials, ops }
  }

  const persist = async (next: StoreSnapshot, ops: [string, string | null][]) => {
    let s = await window.api.saveStore(next)
    for (const [id, v] of ops) s = await window.api.setSecret(id, v)
    setStore(s)
    setEditing(null)
    return s
  }

  const saveHost = async (host: Host, edits: SecretEdits) => {
    if (!store) return
    const { defaults, credentials, ops } = applyLogin(store, host.id, host.overrides, edits.login)
    if (edits.community !== undefined) ops.push([snmpSecretId(host.id), edits.community])
    const h = { ...host, overrides: defaults }
    const exists = store.hosts.some((x) => x.id === h.id)
    await persist({ ...store, credentials, hosts: exists ? store.hosts.map((x) => (x.id === h.id ? h : x)) : [...store.hosts, h] }, ops)
    window.api.monitorProbe([h.id])
  }

  const saveFolder = async (folder: Folder, edits: SecretEdits, applyInside: boolean) => {
    if (!store) return
    const { defaults, credentials, ops } = applyLogin(store, folder.id, folder.defaults, edits.login)
    if (edits.community !== undefined) ops.push([snmpSecretId(folder.id), edits.community])
    const f = { ...folder, defaults }
    const exists = store.folders.some((x) => x.id === f.id)
    let next: StoreSnapshot = { ...store, credentials, folders: exists ? store.folders.map((x) => (x.id === f.id ? f : x)) : [...store.folders, f] }
    if (applyInside && exists) {
      // Everything inside, at any depth, forgets its own settings and inherits along the folder chain.
      const inside = subtreeIds(next.folders, f.id)
      const r = inheritFromFolders(next, next.hosts.filter((h) => h.folderId && inside.has(h.folderId)).map((h) => h.id), [...inside].filter((id) => id !== f.id))
      next = r.store
      ops.push(...r.ops)
    }
    const s = await persist(next, ops)
    window.api.monitorProbe(hostsInSubtree(s, f.id).map((h) => h.id))
  }

  const saveCredential = async (c: Credential, password: string | undefined) => {
    if (!store) return
    const exists = store.credentials.some((x) => x.id === c.id)
    await persist({ ...store, credentials: exists ? store.credentials.map((x) => (x.id === c.id ? c : x)) : [...store.credentials, c] }, password ? [[c.id, password]] : [])
  }

  const deleteCredential = async (c: Credential) => {
    if (!store || !(await ask(`Удалить учётку «${c.name}»?`, DEL))) return
    const unset = <T extends { credentialId?: string }>(d: T) => (d.credentialId === c.id ? { ...d, credentialId: undefined } : d)
    save({
      ...store,
      credentials: store.credentials.filter((x) => x.id !== c.id),
      hosts: store.hosts.map((h) => ({ ...h, overrides: unset(h.overrides) })),
      folders: store.folders.map((f) => ({ ...f, defaults: unset(f.defaults) }))
    })
    setEditing(null)
  }

  const deleteHost = async (host: Host) => {
    if (!store || !(await ask(`Удалить хост «${host.name}»?`, DEL))) return
    save(removeItems(store, { folders: new Set(), hosts: new Set([host.id]) }))
    setEditing(null)
  }

  /**
   * A folder with something inside: delete it with everything in it (subfolders at any depth and
   * their hosts), or only the folder, its contents moving one level up.
   */
  const deleteFolder = async (folder: Folder) => {
    if (!store) return
    const scope = deletionScope(store, [], [folder.id])
    const subs = scope.folders.size - 1
    const what = contentsText(subs, scope.hosts.size)
    const how = what
      ? await choose(`Папка «${folder.name}»: внутри ${what}.\n\nУдалить её вместе со всем содержимым или только саму папку (содержимое переедет на уровень выше)?`, [
          { label: 'Только папку', value: 'lift' as const },
          { label: 'Удалить всё', value: 'all' as const, destructive: true }
        ])
      : (await ask(`Удалить пустую папку «${folder.name}»?`, DEL)) && ('all' as const)
    if (!how) return
    if (how === 'all') save(removeItems(store, scope))
    else
      save({
        ...store,
        folders: store.folders.filter((f) => f.id !== folder.id).map((f) => (f.parentId === folder.id ? { ...f, parentId: folder.parentId } : f)),
        hosts: store.hosts.map((h) => (h.folderId === folder.id ? { ...h, folderId: folder.parentId } : h))
      })
    if (folderId && (how === 'all' ? scope.folders.has(folderId) : folderId === folder.id)) setFolderId(folder.parentId)
    setEditing(null)
  }

  /** Everything picked with Ctrl + click; folders go with all they hold. */
  const deleteItems = async (hostIds: string[], folderIds: string[]) => {
    if (!store) return
    const scope = deletionScope(store, hostIds, folderIds)
    const inside = contentsText(scope.folders.size - folderIds.length, scope.hosts.size - hostIds.length)
    const picked = [folderIds.length && plural(folderIds.length, 'папку', 'папки', 'папок'), hostIds.length && plural(hostIds.length, 'хост', 'хоста', 'хостов')].filter(Boolean).join(' и ')
    if (!(await ask(`Удалить ${picked}?${inside ? `\nВместе с папками удалится всё, что в них лежит: ${inside}.` : ''}`, DEL))) return
    save(removeItems(store, scope))
    // Opened folder deleted: go up to the nearest one left.
    let up = folderId
    while (up && scope.folders.has(up)) up = store.folders.find((f) => f.id === up)?.parentId ?? null
    if (up !== folderId) setFolderId(up)
  }

  const saveSettings = (settings: AppSettings) => {
    if (!store) return
    applyTheme(settings)
    save({ ...store, settings })
  }

  const saveMaps = (maps: NetMap[]) => store && save({ ...store, maps })

  /** Drag and drop onto a folder. */
  const moveItems: MoveItems = (hostIds, folderIds, target) => {
    if (!store) return
    save(moveInto(store, hostIds, folderIds, target))
    if (hostIds.length) window.api.monitorProbe(hostIds)
  }

  /** Hosts and folders forget their own connection settings and take them from their folders. */
  const inheritSettings = async (hostIds: string[], folderIds: string[]) => {
    if (!store) return
    const sum = ownSummary(store, hostIds, folderIds)
    if (!sum.items) return setError({ title: 'Своих настроек нет', text: 'Выбранные хосты и папки уже берут всё из папок.' })
    if (!(await ask(`${sum.items} шт. забудут свои настройки (${describeOwn(sum.fields)}) и возьмут их из папок, в которых лежат. Продолжить?`, { ok: 'Продолжить' }))) return
    const r = inheritFromFolders(store, hostIds, folderIds)
    await persist(r.store, r.ops)
    window.api.monitorProbe(hostIds)
  }

  const saveWorkspace = (w: Workspace, groupId?: string) => {
    if (!store) return
    const list = store.workspaces ?? []
    save({ ...store, workspaces: list.some((x) => x.id === w.id) ? list.map((x) => (x.id === w.id ? w : x)) : [...list, w] })
    // A group saved as a workspace becomes that workspace's tab.
    if (groupId) setGroups((gs) => gs.map((g) => (g.id === groupId ? { ...g, title: w.name, workspaceId: w.id } : g)))
    setEditing(null)
  }

  const deleteWorkspace = async (w: Workspace) => {
    if (!store || !(await ask(`Удалить Workspace «${w.name}»? Хосты останутся на месте.`, DEL))) return
    save({ ...store, workspaces: (store.workspaces ?? []).filter((x) => x.id !== w.id) })
    setGroups((gs) => gs.map((g) => (g.workspaceId === w.id ? { ...g, workspaceId: undefined } : g)))
    setEditing(null)
  }

  const openTools = (hostId: string, address?: string) => {
    const h = store?.hosts.find((x) => x.id === hostId)
    if (h) setToolsTarget({ address: address ?? h.address, tab: 'ping', at: Date.now() }), setScreen('tools')
  }
  const run = (p: Promise<void>, title: string) => p.catch((e) => setError({ title, text: errorText(e) }))

  const openCount = useMemo(() => {
    const m = new Map<string, number>()
    sessions.forEach((s) => !s.closed && m.set(s.hostId, (m.get(s.hostId) ?? 0) + 1))
    return m
  }, [sessions])
  const connecting = useMemo(() => new Set(pending.map((p) => p.hostId)), [pending])
  const tintOf = (hostId: string) => {
    const h = store?.hosts.find((x) => x.id === hostId)
    return store && h ? hostTint(store, h) : 'blue'
  }

  if (!store) return null

  /** Opening a folder from anywhere (card, breadcrumb, sidebar) remembers where "Назад" returns to. */
  const openFolder = (id: string | null) => {
    if (id === folderId) return
    setFolderHistory((h) => [...h.slice(-49), folderId])
    setFolderId(id)
  }
  const folderExists = (id: string | null) => id === null || store.folders.some((f) => f.id === id)
  const backTarget = (): { to: string | null; history: (string | null)[] } | undefined => {
    const h = [...folderHistory]
    while (h.length) {
      const prev = h.pop()!
      if (prev !== folderId && folderExists(prev)) return { to: prev, history: h }
    }
    // Nothing visited before (opened at start or history ran out): one level up.
    if (folderId) return { to: store.folders.find((f) => f.id === folderId)?.parentId ?? null, history: [] }
  }
  const goBack = () => {
    const b = backTarget()
    if (b) setFolderHistory(b.history), setFolderId(b.to)
  }

  const folderMenu = (f: Folder): MenuItem[] => [
    { label: 'Открыть', icon: 'folder', onSelect: () => (openFolder(f.id), setScreen('hosts')) },
    { label: 'Подключиться ко всем', icon: 'play', onSelect: () => connectMany(hostsInSubtree(store, f.id).map((h) => h.id), f.name) },
    { label: 'Новая подпапка', icon: 'folder', sep: true, onSelect: () => setEditing({ kind: 'folder', folder: null, parentId: f.id }) },
    { label: 'Новый хост здесь', icon: 'plus', onSelect: () => setEditing({ kind: 'host', host: null, folderId: f.id }) },
    { label: 'Изменить', icon: 'pencil', sep: true, onSelect: () => setEditing({ kind: 'folder', folder: f, parentId: f.parentId ?? null }) },
    { label: 'Значок и цвет', icon: 'palette', onSelect: () => setEditing({ kind: 'appearance', folderIds: [f.id], hostIds: [] }) },
    { label: 'Удалить папку', icon: 'trash', destructive: true, sep: true, onSelect: () => deleteFolder(f) }
  ]
  const workspaceMenu = (w: Workspace): MenuItem[] => [
    { label: 'Открыть', icon: 'grid', onSelect: () => openWorkspace(w) },
    { label: 'Изменить', icon: 'pencil', onSelect: () => setEditing({ kind: 'workspace', workspace: w }) },
    { label: 'Удалить', icon: 'trash', destructive: true, sep: true, onSelect: () => deleteWorkspace(w) }
  ]
  const navMenu = (id: Screen): MenuItem[] => {
    if (id === 'hosts') return [
      { label: 'Новый хост', icon: 'plus', onSelect: () => setEditing({ kind: 'host', host: null, folderId: null }) },
      { label: 'Новая папка', icon: 'folder', onSelect: () => setEditing({ kind: 'folder', folder: null, parentId: null }) }
    ]
    if (id === 'credentials') return [{ label: 'Новая учётка', icon: 'plus', onSelect: () => (setScreen('credentials'), setEditing({ kind: 'credential', credential: null })) }]
    if (id === 'map') return [{ label: 'Открыть карту', icon: 'map', onSelect: () => setScreen('map') }]
    return []
  }

  const down = healthSummary(store.hosts.map((h) => h.id), status).down
  const nav: { id: Screen; label: string; icon: IconName; count?: number; alert?: number }[] = [
    { id: 'hosts', label: 'Хосты', icon: 'server', alert: down },
    { id: 'sessions', label: 'Сессии', icon: 'terminal', count: sessions.filter((s) => !s.closed).length + pending.length },
    { id: 'map', label: 'Карта сети', icon: 'map', count: store.maps.length || undefined },
    { id: 'tools', label: 'Инструменты', icon: 'wrench' },
    { id: 'credentials', label: 'Учётные данные', icon: 'key', count: store.credentials.length || undefined }
  ]

  return (
    <div className={`app ${rail ? 'is-rail' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar__brand drag">
          <Icon name="terminal" size={18} />
          <span className="sidebar__brand-name">Pult</span>
          <IconButton icon="sidebar" label={rail ? 'Развернуть левую панель' : 'Свернуть левую панель'} onClick={toggleRail} />
        </div>
        <nav className="sidebar__nav">
          {nav.map((n) => (
            <button
              key={n.id}
              className={['nav-item', screen === n.id && 'is-active'].filter(Boolean).join(' ')}
              title={rail ? n.label : undefined}
              onContextMenu={(e) => openContextMenu(e, navMenu(n.id))}
              onClick={() => {
                setScreen(n.id)
                if (n.id === 'hosts' && screen === 'hosts') openFolder(null)
              }}
            >
              <Icon name={n.icon} size={18} />
              <span>{n.label}</span>
              {n.alert ? <Badge tint="red">{n.alert}</Badge> : n.count ? <span className="nav-item__count">{n.count}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar__section">
          <h4 onContextMenu={(e) => openContextMenu(e, [{ label: 'Новый Workspace', icon: 'plus', onSelect: () => setEditing({ kind: 'workspace', workspace: null }) }])}>
            Workspace
            <IconButton icon="plus" label="Новый Workspace" onClick={() => setEditing({ kind: 'workspace', workspace: null })} />
          </h4>
          {(store.workspaces ?? []).map((w) => {
            const open = groups.some((g) => g.workspaceId === w.id)
            return (
              <div key={w.id} className="ws-row" onContextMenu={(e) => openContextMenu(e, workspaceMenu(w), w.name)}>
                <button className={['nav-item nav-item--sm', open && screen === 'sessions' && groups.some((g) => g.workspaceId === w.id && groupKey(g.id) === activeTab) && 'is-active'].filter(Boolean).join(' ')} title={`Открыть все ${w.hostIds.length} одной вкладкой`} onClick={() => openWorkspace(w)}>
                  <Icon name="grid" size={15} />
                  <span>{w.name}</span>
                  <span className="nav-item__count">{open ? <span className="ws-open" title="Открыт">●</span> : null}{w.hostIds.length}</span>
                </button>
                <IconButton icon="pencil" label="Изменить Workspace" onClick={() => setEditing({ kind: 'workspace', workspace: w })} />
              </div>
            )
          })}
          {!store.workspaces?.length && <p className="sidebar__hint">Набор коммутаторов, который открывается одной вкладкой. Выберите хосты Ctrl + кликом и нажмите «В Workspace».</p>}
        </div>

        {store.folders.length > 0 && (
          <div className="sidebar__section">
            <h4 onContextMenu={(e) => openContextMenu(e, [{ label: 'Новая папка', icon: 'folder', onSelect: () => setEditing({ kind: 'folder', folder: null, parentId: null }) }])}>Папки</h4>
            <FolderTree
              store={store}
              status={status}
              parentId={null}
              depth={0}
              current={screen === 'hosts' ? folderId : null}
              onOpen={(id) => (openFolder(id), setScreen('hosts'))}
              onMenu={(e, f) => openContextMenu(e, folderMenu(f), f.name)}
              expanded={treeOpen}
              onToggle={toggleTreeFolder}
              drop={(target) => dropTarget(target, moveItems, setDropOver)}
              over={dropOver}
            />
          </div>
        )}

        <span className="sidebar__spacer" />
        <button className={['nav-item', screen === 'settings' && 'is-active'].filter(Boolean).join(' ')} title={rail ? 'Настройки' : undefined} onClick={() => setScreen('settings')}>
          <Icon name="gear" size={18} />
          <span>Настройки</span>
        </button>
      </aside>

      <main className="content">
        {error && (
          <div className="toast-area" onMouseEnter={() => setErrorHeld(true)} onMouseLeave={() => setErrorHeld(false)}>
            <Banner title={error.title} onClose={() => (setError(null), setErrorHeld(false))}>{error.text}</Banner>
          </div>
        )}

        {screen === 'hosts' && (
          <HostsScreen
            store={store}
            status={status}
            folderId={folderId}
            onOpenFolder={openFolder}
            onBack={backTarget() ? goBack : undefined}
            openCount={openCount}
            connecting={connecting}
            onConnect={(id, address) => void connect(id, undefined, address)}
            onConnectFolder={(id) => connectMany(hostsInSubtree(store, id).map((h) => h.id), store.folders.find((f) => f.id === id)?.name ?? 'Папка')}
            onEditHost={(host) => setEditing({ kind: 'host', host })}
            onNewHost={(fid) => setEditing({ kind: 'host', host: null, folderId: fid })}
            onEditFolder={(folder, parentId) => setEditing({ kind: 'folder', folder, parentId: parentId ?? folderId })}
            onDeleteHost={deleteHost}
            onDeleteFolder={deleteFolder}
            onDeleteItems={deleteItems}
            onBrowser={(id, address) => run(window.api.openInBrowser(id, address), 'Не удалось открыть браузер')}
            onWinbox={(id, address) => run(window.api.openWinbox(id, address), 'Не удалось запустить WinBox')}
            onTools={openTools}
            onConnectMany={(ids) => connectMany(ids, `Выбранные: ${ids.length}`)}
            onAppearance={(folderIds, hostIds) => setEditing({ kind: 'appearance', folderIds, hostIds })}
            onMove={moveItems}
            onInherit={inheritSettings}
            onNewWorkspace={(hostIds) => setEditing({ kind: 'workspace', workspace: null, hostIds })}
          />
        )}

        {/* Kept mounted while on other screens so terminals keep their state. */}
        <div className="screen-host" style={{ display: screen === 'sessions' ? 'contents' : 'none' }}>
          <SessionsScreen
            shown={screen === 'sessions'}
            sessions={attached}
            groups={groups}
            tabs={tabs}
            pending={pending}
            detachedCount={detached.size}
            tintOf={tintOf}
            layout={layout}
            onLayout={setLayout}
            activeTab={activeTab}
            onActivateTab={(key) => (setActiveTab(key), setLayout('tabs'), !key.startsWith('g:') && setActive(key))}
            active={active}
            onActivate={setActive}
            group={group}
            onToggleGroup={(id) => setGroup((g) => (g.has(id) ? without(g, id) : new Set(g).add(id)))}
            onGroupAll={(ids, on) => setGroup((g) => (on ? new Set([...g, ...ids]) : new Set([...g].filter((id) => !ids.includes(id)))))}
            broadcast={broadcast}
            onBroadcast={setBroadcast}
            onInput={onInput}
            onPopout={popout}
            onReconnect={reconnect}
            onClose={closeSession}
            onCloseTab={closeTab}
            onCloseDead={(ids) => ids.forEach(closeSession)}
            onSaveWorkspace={(groupId) => {
              const g = groups.find((x) => x.id === groupId)
              const hostIds = [...new Set(sessions.filter((s) => s.groupId === groupId).map((s) => s.hostId))]
              setEditing({ kind: 'workspace', workspace: null, hostIds, name: g?.title, groupId })
            }}
            onGoHosts={() => setScreen('hosts')}
          />
        </div>

        {screen === 'map' && (
          <MapScreen
            store={store}
            status={status}
            openCount={openCount}
            onSaveMaps={saveMaps}
            onConnect={(id, address) => void connect(id, undefined, address)}
            onConnectMany={(ids, title) => connectMany(ids, title ?? 'Карта')}
            onBrowser={(id, address) => run(window.api.openInBrowser(id, address), 'Не удалось открыть браузер')}
            onWinbox={(id, address) => run(window.api.openWinbox(id, address), 'Не удалось запустить WinBox')}
            onTools={openTools}
            onEditHost={(id) => setEditing({ kind: 'host', host: store.hosts.find((h) => h.id === id) ?? null })}
            onAppearance={(hostIds) => setEditing({ kind: 'appearance', folderIds: [], hostIds })}
            animations={store.settings?.animations ?? true}
            onError={(title, text) => setError({ title, text })}
          />
        )}

        {/* Mounted from the first visit on, so a running ping keeps going on other screens. */}
        {(toolsOpen || screen === 'tools') && (
          <div className="screen-host" style={{ display: screen === 'tools' ? 'contents' : 'none' }}>
            <ToolsScreen store={store} target={toolsTarget} />
          </div>
        )}

        {screen === 'credentials' && <CredentialsScreen store={store} onEdit={(credential) => setEditing({ kind: 'credential', credential })} />}
        {screen === 'settings' && <SettingsScreen settings={store.settings ?? {}} credentials={store.credentials} folders={store.folders} onChange={saveSettings} onOpenCredentials={() => setScreen('credentials')} onImported={(s) => (setStore(s), applyTheme(s.settings))} />}
      </main>

      {designOf(store.settings) === 'ferrum' && <StatusBar store={store} sessions={nav[1].count ?? 0} down={down} broadcast={broadcast ? [...group].filter((id) => onScreen.has(id)).length : 0} />}

      {editing?.kind === 'host' && (
        <HostSheet store={store} host={editing.host} defaultFolderId={editing.folderId !== undefined ? editing.folderId : folderId} onCancel={() => setEditing(null)} onSave={saveHost} onDelete={deleteHost} />
      )}
      {editing?.kind === 'folder' && (
        <FolderSheet store={store} folder={editing.folder} defaultParentId={editing.parentId} onCancel={() => setEditing(null)} onSave={saveFolder} onDelete={deleteFolder} />
      )}
      {editing?.kind === 'appearance' && (
        <AppearanceSheet
          folderCount={editing.folderIds.length}
          hostCount={editing.hostIds.length}
          onCancel={() => setEditing(null)}
          onApply={(patch) => (save(applyAppearance(store, editing.folderIds, editing.hostIds, patch)), setEditing(null))}
        />
      )}
      {editing?.kind === 'workspace' && (
        <WorkspaceSheet
          store={store}
          workspace={editing.workspace}
          initialHostIds={editing.hostIds}
          initialName={editing.name}
          onCancel={() => setEditing(null)}
          onSave={(w) => saveWorkspace(w, editing.groupId)}
          onDelete={deleteWorkspace}
        />
      )}
      {editing?.kind === 'credential' && (
        <CredentialSheet
          store={store}
          credential={editing.credential}
          usedBy={editing.credential ? store.hosts.filter((h) => h.overrides.credentialId === editing.credential!.id).length + store.folders.filter((f) => f.defaults.credentialId === editing.credential!.id).length : 0}
          onCancel={() => setEditing(null)}
          onSave={saveCredential}
          onDelete={deleteCredential}
        />
      )}
      <ConfirmHost />
      <ContextMenuHost />
      {keyPrompts[0] && (
        <HostKeySheet prompt={keyPrompts[0]} queued={keyPrompts.slice(1).filter((p) => !p.previous).length} onAnswer={answerKey} onTrustAllNew={trustAllNew} />
      )}
    </div>
  )
}

const TREE_OPEN_KEY = 'folderTree.open'
const RAIL_KEY = 'sidebar.rail'

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

/** Expanded sidebar folders, kept across restarts (Electron keeps localStorage in userData). New folders start collapsed. */
function loadTreeOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(TREE_OPEN_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveTreeOpen(s: Set<string>): void {
  try {
    localStorage.setItem(TREE_OPEN_KEY, JSON.stringify([...s]))
  } catch {
    /* storage unavailable: state just won't survive a restart */
  }
}

/** Sidebar tree: any depth, collapsible, with a red dot where something inside is down. */
function FolderTree({ store, status, parentId, depth, current, onOpen, onMenu, expanded, onToggle, drop, over }: {
  store: StoreSnapshot
  status: Map<string, HostStatus>
  parentId: string | null
  depth: number
  current: string | null
  onOpen(id: string): void
  onMenu(e: ReactMouseEvent, folder: Folder): void
  expanded: Set<string>
  onToggle(id: string): void
  /** Drop handlers for a folder: dragged hosts and folders move into it. */
  drop(target: string): ReturnType<typeof dropTarget>
  over: string | null | undefined
}) {
  const children = store.folders.filter((f) => f.parentId === parentId)
  return (
    <>
      {children.map((f) => {
        const hasKids = store.folders.some((x) => x.parentId === f.id)
        const open = expanded.has(f.id)
        const s = healthSummary(hostsInSubtree(store, f.id).map((h) => h.id), status)
        return (
          <div key={f.id}>
            <button
              className={['nav-item nav-item--sm tree-item', current === f.id && 'is-active', over === f.id && 'is-drop-target'].filter(Boolean).join(' ')}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onOpen(f.id)}
              onContextMenu={(e) => onMenu(e, f)}
              {...drop(f.id)}
            >
              <span
                className={`tree-item__chevron ${hasKids ? '' : 'is-empty'} ${open ? 'is-open' : ''}`}
                onClick={(e) => (e.stopPropagation(), hasKids && onToggle(f.id))}
              >
                <Icon name="chevronRight" size={11} />
              </span>
              <span className={`tree-item__icon tint-${f.tint ?? 'gray'}`}>
                <Icon name={kindMeta(f.kind).icon} size={15} />
              </span>
              <span>{f.name}</span>
              {s.down > 0 ? <HealthDot health="down" title={`${s.down} недоступно`} /> : <span className="nav-item__count">{s.up + s.down + s.unknown || ''}</span>}
            </button>
            {hasKids && open && <FolderTree store={store} status={status} parentId={f.id} depth={depth + 1} current={current} onOpen={onOpen} onMenu={onMenu} expanded={expanded} onToggle={onToggle} drop={drop} over={over} />}
          </div>
        )
      })}
    </>
  )
}

function without<T>(s: Set<T>, v: T): Set<T> {
  const n = new Set(s)
  n.delete(v)
  return n
}

/** Ferrum's bottom line: what is open, what is broadcast, what monitoring sees, and that the app stays in the LAN. */
function StatusBar({ store, sessions, down, broadcast }: { store: StoreSnapshot; sessions: number; down: number; broadcast: number }) {
  const hosts = store.hosts.length
  return (
    <footer className="statusbar" aria-label="Состояние">
      <span className={`statusbar__item ${sessions ? 'is-on' : ''}`}>
        <span className={`ds-dot ds-dot--${sessions ? 'online' : 'offline'}`} />
        {plural(sessions, 'сессия', 'сессии', 'сессий')}
      </span>
      <span className={`statusbar__item ${broadcast ? 'is-warn' : ''}`}>
        broadcast: {broadcast ? `вкл · ${plural(broadcast, 'сессия', 'сессии', 'сессий')}` : 'выкл'}
      </span>
      <span className="statusbar__item">мониторинг: {plural(hosts, 'хост', 'хоста', 'хостов')}</span>
      {down > 0 && <span className="statusbar__item is-bad">{down} недоступно</span>}
      <span className="statusbar__spacer" />
      <span className="statusbar__item">LAN · без интернета</span>
      <span className="statusbar__item is-accent">{themeById(store.settings?.theme, 'ferrum').name}</span>
    </footer>
  )
}
