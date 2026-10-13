import { useState } from 'react'
import type { Tint } from '@shared/types'
import { Button, EmptyState, IconButton, Segmented, Toggle } from '../design/components'
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
  group: Set<string>
  onToggleGroup(id: string): void
  /** Select (or clear) every live session on screen for broadcast. */
  onGroupAll(ids: string[], on: boolean): void
  syncInput: boolean
  onSyncInput(v: boolean): void
  onInput(sessionId: string, data: string): void
  onBroadcast(command: string, targets: string[]): void
  onPopout(s: PaneSession): void
  onClose(id: string): void
  onCloseTab(key: string): void
  /** Save the hosts of a group as a workspace. */
  onSaveWorkspace(groupId: string): void
  onGoHosts(): void
}

export function SessionsScreen(p: Props) {
  const [command, setCommand] = useState('')
  const [maximized, setMaximized] = useState<string | null>(null)
  const visible = visibleSessions(p.sessions, p.activeTab, p.layout)
  const max = visible.some((s) => s.sessionId === maximized) ? maximized : null
  const shown = max ? 1 : visible.length
  const { cols, rows } = gridShape(shown)
  const live = visible.filter((s) => !s.closed)
  const targets = live.filter((s) => p.group.has(s.sessionId)).map((s) => s.sessionId)
  const activeGroup = p.activeTab?.startsWith('g:') ? p.groups.find((g) => g.id === p.activeTab!.slice(2)) : undefined

  const send = () => {
    if (!command || targets.length === 0) return
    p.onBroadcast(command, targets)
    setCommand('')
  }

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
                className={['tab', key === p.activeTab && p.layout === 'tabs' && 'is-active', p.group.has(key) && 'in-group', s.closed && 'is-closed'].filter(Boolean).join(' ')}
                onClick={() => p.onActivateTab(key)}
                onAuxClick={(e) => e.button === 1 && p.onCloseTab(key)}
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
          {activeGroup && !activeGroup.workspaceId && p.layout === 'tabs' && (
            <Button variant="plain" size="sm" icon="grid" onClick={() => p.onSaveWorkspace(activeGroup.id)}>Сохранить как Workspace</Button>
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
            inGroup={p.group.has(s.sessionId)}
            broadcasting={p.syncInput && p.group.has(s.sessionId)}
            onFocus={() => p.onActivate(s.sessionId)}
            onInput={p.onInput}
            onToggleGroup={() => p.onToggleGroup(s.sessionId)}
            onMaximize={visible.length > 1 ? () => setMaximized(max === s.sessionId ? null : s.sessionId) : undefined}
            maximized={max === s.sessionId}
            onPopout={() => p.onPopout(s)}
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

      <footer className={['broadcast', targets.length > 0 && 'is-armed', p.syncInput && targets.length > 0 && 'is-sync'].filter(Boolean).join(' ')}>
        <Icon name="broadcast" size={18} />
        <span className="broadcast__count" title="Broadcast идёт только в отмеченные сессии на экране">
          {targets.length} из {live.length}
        </span>
        <Button variant="plain" size="sm" disabled={!live.length} onClick={() => p.onGroupAll(live.map((s) => s.sessionId), targets.length < live.length)}>
          {targets.length < live.length ? 'Выбрать все' : 'Снять все'}
        </Button>
        <input
          className="broadcast__input mono"
          placeholder={targets.length ? `Команда в ${targets.length} сесс. и Enter` : 'Отметьте сессии значком broadcast в заголовке'}
          value={command}
          disabled={!targets.length}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <label className="broadcast__sync" title="Каждое нажатие в любой отмеченной сессии на экране уходит во все отмеченные сессии на экране">
          Синхронный ввод
          <Toggle checked={p.syncInput} onChange={p.onSyncInput} label="Синхронный ввод" />
        </label>
      </footer>
    </div>
  )
}
