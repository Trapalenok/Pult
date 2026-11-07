import { useEffect, useState } from 'react'
import type { Tint } from '@shared/types'
import { Button, EmptyState, IconButton, openContextMenu, Segmented } from '../design/components'
import { Icon } from '../design/icons'
import { TerminalPane, type PaneSession } from '../terminal/TerminalPane'

export type Layout = 'tabs' | 'grid'

/**
 * Sessions opened together (a workspace, a folder, a map sheet, picked hosts) share one tab and
 * one grid instead of a tab each.
 */
export interface SessionGroup {
  id: string
  title: string
  /** Set when the group was opened from a saved workspace. */
  workspaceId?: string
}

/** Tab key of a group; a single session's tab key is its session id. */
export const groupKey = (groupId: string) => `g:${groupId}`

/**
 * Sessions on screen: all of them in the "everything" grid, otherwise those of the active tab.
 * Broadcast only ever reaches sessions on screen.
 */
export function visibleSessions(sessions: PaneSession[], activeTab: string | null, layout: Layout): PaneSession[] {
  if (layout === 'grid') return sessions
  if (activeTab?.startsWith('g:')) return sessions.filter((s) => s.groupId === activeTab.slice(2))
  return sessions.filter((s) => s.sessionId === activeTab)
}

/** Columns × rows for n panes: as square as possible, no upper limit. */
export function gridShape(n: number): { cols: number; rows: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) }
}

interface Props {
  /** The sessions screen is the one on display (it stays mounted behind the others). */
  shown: boolean
  sessions: PaneSession[]
  groups: SessionGroup[]
  /** Tab keys in the order they were opened. */
  tabs: string[]
  pending: { key: string; title: string; groupId?: string }[]
  detachedCount: number
  tintOf(hostId: string): Tint
  layout: Layout
  onLayout(l: Layout): void
  activeTab: string | null
  onActivateTab(key: string): void
  /** Focused session (keyboard input). */
  active: string | null
  onActivate(id: string): void
  /** Sessions marked for broadcast. */
  group: Set<string>
  onToggleGroup(id: string): void
  /** Select (or clear) every live session on screen for broadcast. */
  onGroupAll(ids: string[], on: boolean): void
  /** Broadcast on: what is typed in a marked session on screen goes to every marked session on screen. */
  broadcast: boolean
  onBroadcast(on: boolean): void
  onInput(sessionId: string, data: string): void
  onPopout(s: PaneSession): void
  /** A closed session connects again in its own pane. */
  onReconnect(id: string): void
  onClose(id: string): void
  onCloseTab(key: string): void
  /** Close the panes of sessions that already ended (connection lost, closed by the switch). */
  onCloseDead(ids: string[]): void
  /** Save the hosts of a group as a workspace. */
  onSaveWorkspace(groupId: string): void
  onGoHosts(): void
}

export function SessionsScreen(p: Props) {
  const [maximized, setMaximized] = useState<string | null>(null)
  const visible = visibleSessions(p.sessions, p.activeTab, p.layout)
  const max = visible.some((s) => s.sessionId === maximized) ? maximized : null
  const shown = max ? 1 : visible.length
  const { cols, rows } = gridShape(shown)
  const live = visible.filter((s) => !s.closed)
  const dead = visible.filter((s) => s.closed)
  const targets = live.filter((s) => p.group.has(s.sessionId)).map((s) => s.sessionId)
  const activeGroup = p.activeTab?.startsWith('g:') ? p.groups.find((g) => g.id === p.activeTab!.slice(2)) : undefined

  // Like Termius: one button, and typing in any terminal on screen goes to all of them. Turning it on marks
  // every live session on screen; the broadcast icon in a pane's header leaves that one out.
  const toggleBroadcast = () => {
    if (!p.broadcast) p.onGroupAll(live.map((s) => s.sessionId), true)
    p.onBroadcast(!p.broadcast)
  }
  useEffect(() => {
    // Ctrl + Shift + B, also while a terminal has the keyboard (capture phase, before xterm sees it).
    const onKey = (e: KeyboardEvent) => {
      if (!p.shown || !(e.ctrlKey && e.shiftKey && e.code === 'KeyB')) return
      e.preventDefault()
      e.stopPropagation()
      toggleBroadcast()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const isShown = (id: string) => (max ? id === max : visible.some((s) => s.sessionId === id))
  const pendingSingles = p.pending.filter((x) => !x.groupId)

  return (
    <div className="screen">
      <div className="screen__bar drag">
        <div className="tabstrip no-drag" role="tablist">
          {p.tabs.map((key) => {
            if (key.startsWith('g:')) {
              const g = p.groups.find((x) => x.id === key.slice(2))
              if (!g) return null
              const members = p.sessions.filter((s) => s.groupId === g.id)
              const waiting = p.pending.filter((x) => x.groupId === g.id).length
              const up = members.filter((s) => !s.closed).length
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={key === p.activeTab && p.layout === 'tabs'}
                  className={['tab tab--group', key === p.activeTab && p.layout === 'tabs' && 'is-active', waiting > 0 && 'is-pending'].filter(Boolean).join(' ')}
                  title={g.workspaceId ? `Workspace «${g.title}»` : g.title}
                  onClick={() => p.onActivateTab(key)}
                  onAuxClick={(e) => e.button === 1 && p.onCloseTab(key)}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: 'Открыть', icon: 'grid', onSelect: () => p.onActivateTab(key) },
                      ...(!g.workspaceId ? [{ label: 'Сохранить как Workspace', icon: 'grid' as const, onSelect: () => p.onSaveWorkspace(g.id) }] : []),
                      ...(members.some((m) => m.closed) ? [{ label: 'Переподключить отключённые', icon: 'reconnect' as const, onSelect: () => members.filter((m) => m.closed).forEach((m) => p.onReconnect(m.sessionId)) }] : []),
                      ...(members.some((m) => m.closed) ? [{ label: 'Убрать отключённые', icon: 'xmark' as const, onSelect: () => p.onCloseDead(members.filter((m) => m.closed).map((m) => m.sessionId)) }] : []),
                      { label: 'Закрыть все', icon: 'xmark', destructive: true, sep: true, onSelect: () => p.onCloseTab(key) }
                    ], g.title)
                  }
                >
                  <Icon name="grid" size={13} />
                  <span className="tab__title">{g.title}</span>
                  <span className="tab__count">{waiting ? `${up} из ${up + waiting}` : up}</span>
                  <span className="tab__close" role="button" aria-label="Закрыть все" onClick={(e) => (e.stopPropagation(), p.onCloseTab(key))}>
                    <Icon name="xmark" size={11} />
                  </span>
                </button>
              )
            }
            const s = p.sessions.find((x) => x.sessionId === key)
            if (!s) return null
            return (
              <button
                key={key}
                role="tab"
                aria-selected={key === p.activeTab && p.layout === 'tabs'}
                className={['tab', key === p.activeTab && p.layout === 'tabs' && 'is-active', p.broadcast && p.group.has(key) && 'in-group', s.closed && 'is-closed'].filter(Boolean).join(' ')}
                onClick={() => p.onActivateTab(key)}
                onAuxClick={(e) => e.button === 1 && p.onCloseTab(key)}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: 'Открыть', icon: 'terminal', onSelect: () => p.onActivateTab(key) },
                    ...(!s.closed ? [{ label: 'В отдельное окно', icon: 'popout' as const, onSelect: () => p.onPopout(s) }] : [{ label: 'Переподключить', icon: 'reconnect' as const, onSelect: () => p.onReconnect(key) }]),
                    { label: 'Закрыть', icon: 'xmark', destructive: true, sep: true, onSelect: () => p.onCloseTab(key) }
                  ], s.title)
                }
              >
                <Icon name="terminal" size={13} />
                <span className="tab__title">{s.title}</span>
                <span className="tab__close" role="button" aria-label="Закрыть" onClick={(e) => (e.stopPropagation(), p.onCloseTab(key))}>
                  <Icon name="xmark" size={11} />
                </span>
              </button>
            )
          })}
          {pendingSingles.map((s) => (
            <span key={s.key} className="tab is-pending">
              <Icon name="terminal" size={13} />
              <span className="tab__title">{s.title}</span>
            </span>
          ))}
          <IconButton icon="plus" label="Новое подключение" onClick={p.onGoHosts} />
        </div>
        <span className="screen__spacer" />
        <div className="no-drag toolbar">
          <Button
            variant={p.broadcast ? 'filled' : 'tinted'}
            size="sm"
            icon="broadcast"
            className={['bc-toggle', p.broadcast && 'is-on'].filter(Boolean).join(' ')}
            disabled={!live.length && !p.broadcast}
            aria-pressed={p.broadcast}
            title={
              p.broadcast
                ? 'Broadcast включён: ввод в любой отмеченной сессии на экране уходит во все отмеченные. Значок broadcast в заголовке сессии исключает её. Ctrl + Shift + B: выключить'
                : 'Включить broadcast: всё, что вы печатаете, пойдёт во все сессии на экране (Ctrl + Shift + B)'
            }
            onClick={toggleBroadcast}
          >
            {p.broadcast ? `Broadcast: ${targets.length} из ${live.length}` : 'Broadcast'}
          </Button>
          {p.broadcast && live.length > 0 && (
            <Button variant="plain" size="sm" onClick={() => p.onGroupAll(live.map((s) => s.sessionId), targets.length < live.length)}>
              {targets.length < live.length ? 'Все' : 'Снять все'}
            </Button>
          )}
          {activeGroup && !activeGroup.workspaceId && p.layout === 'tabs' && (
            <Button variant="plain" size="sm" icon="grid" onClick={() => p.onSaveWorkspace(activeGroup.id)}>Сохранить как Workspace</Button>
          )}
          {dead.length > 1 && (
            <Button variant="plain" size="sm" icon="reconnect" title="Подключить снова все отключившиеся сессии на экране, каждую в своём окне" onClick={() => dead.forEach((s) => p.onReconnect(s.sessionId))}>
              Переподключить: {dead.length}
            </Button>
          )}
          {dead.length > 0 && (
            <Button variant="plain" size="sm" icon="xmark" title="Закрыть панели сессий, которые уже отключились" onClick={() => p.onCloseDead(dead.map((s) => s.sessionId))}>
              Убрать отключённые: {dead.length}
            </Button>
          )}
          {p.detachedCount > 0 && <span className="muted">{p.detachedCount} в отдельных окнах</span>}
          <Segmented
            size="sm"
            value={p.layout}
            onChange={(l) => (setMaximized(null), p.onLayout(l))}
            options={[
              { value: 'tabs', icon: 'tabs', title: 'Вкладки: группа или одна сессия' },
              { value: 'grid', icon: 'grid', title: 'Все сессии сразу в одной сетке' }
            ]}
          />
        </div>
      </div>

      <div className="workspace" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {p.sessions.map((s) => (
          <TerminalPane
            key={s.sessionId}
            session={s}
            tint={p.tintOf(s.hostId)}
            visible={isShown(s.sessionId)}
            focused={s.sessionId === p.active}
            inGroup={p.broadcast && p.group.has(s.sessionId)}
            broadcasting={p.broadcast && p.group.has(s.sessionId)}
            onFocus={() => p.onActivate(s.sessionId)}
            onInput={p.onInput}
            onToggleGroup={p.broadcast && !s.closed ? () => p.onToggleGroup(s.sessionId) : undefined}
            onMaximize={visible.length > 1 ? () => setMaximized(max === s.sessionId ? null : s.sessionId) : undefined}
            maximized={max === s.sessionId}
            onPopout={s.closed ? undefined : () => p.onPopout(s)}
            onReconnect={() => p.onReconnect(s.sessionId)}
            onClose={() => p.onClose(s.sessionId)}
          />
        ))}
        {visible.length === 0 && (
          <EmptyState
            icon="terminal"
            title={p.pending.length ? 'Подключаюсь…' : 'Нет открытых сессий'}
            message={p.pending.length ? undefined : 'Выберите хост, папку или Workspace. Папка и Workspace открываются одной вкладкой со всеми коммутаторами в сетке.'}
            action={!p.pending.length && <Button variant="filled" icon="server" onClick={p.onGoHosts}>К хостам</Button>}
          />
        )}
      </div>

    </div>
  )
}
