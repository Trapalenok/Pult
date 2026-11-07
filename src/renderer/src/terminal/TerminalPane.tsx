import type { SessionInfo, Tint } from '@shared/types'
import { Button, IconButton, StatusDot, Tile } from '../design/components'
import { TerminalView } from './TerminalView'

export interface PaneSession extends SessionInfo {
  closed?: string
  /** "Переподключить" pressed, the new connection is not up yet. */
  reconnecting?: boolean
  /** The group tab it opened in (workspace, folder, map sheet); none = its own tab. */
  groupId?: string
}

interface Props {
  session: PaneSession
  tint: Tint
  visible: boolean
  focused: boolean
  inGroup: boolean
  broadcasting: boolean
  onFocus(): void
  onInput(sessionId: string, data: string): void
  onToggleGroup?(): void
  onMaximize?(): void
  maximized?: boolean
  onPopout?(): void
  /** Connect the closed session again in this same pane. */
  onReconnect?(): void
  onClose(): void
}

/** One terminal with its header: the unit of the tab view, the grid and a popped-out window. */
export function TerminalPane(p: Props) {
  const { session } = p
  return (
    <div
      className={['pane', p.focused && 'is-focused', p.inGroup && 'in-group', p.broadcasting && 'is-broadcasting'].filter(Boolean).join(' ')}
      style={{ display: p.visible ? 'flex' : 'none' }}
      onMouseDown={p.onFocus}
    >
      <header className="pane__bar">
        <Tile tint={p.tint} icon="terminal" size="sm" />
        <span className="pane__title">{session.title}</span>
        {session.address && <span className="pane__addr mono" title="Адрес этой сессии">{session.address}</span>}
        <StatusDot state={session.reconnecting ? 'connecting' : session.closed ? 'offline' : 'online'} />
        {session.closed && <span className="pane__closed">{session.reconnecting ? 'переподключаюсь…' : session.closed}</span>}
        <span className="pane__spacer" />
        {session.closed && p.onReconnect && (
          <Button variant="filled" size="sm" icon="reconnect" className="pane__reconnect" disabled={session.reconnecting} title="Подключиться снова в этом же окне (Enter в терминале)" onClick={p.onReconnect}>
            Переподключить
          </Button>
        )}
        {p.onToggleGroup && (
          <IconButton icon="broadcast" label={p.inGroup ? 'Убрать из группы broadcast' : 'Добавить в группу broadcast'} active={p.inGroup} onClick={p.onToggleGroup} />
        )}
        {p.onMaximize && <IconButton icon="maximize" label={p.maximized ? 'Вернуть в сетку' : 'Развернуть'} active={p.maximized} onClick={p.onMaximize} />}
        {p.onPopout && <IconButton icon="popout" label="Открыть в отдельном окне" onClick={p.onPopout} />}
        <IconButton icon="xmark" label="Закрыть сессию" onClick={p.onClose} />
      </header>
      <div className="pane__term">
        <TerminalView sessionId={session.sessionId} visible={p.visible} focused={p.focused} onInput={p.onInput} />
      </div>
    </div>
  )
}
