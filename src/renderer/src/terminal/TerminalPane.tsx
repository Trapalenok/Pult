import type { SessionInfo, Tint } from '@shared/types'
import { IconButton, StatusDot, Tile } from '../design/components'
import { TerminalView } from './TerminalView'

export interface PaneSession extends SessionInfo {
  closed?: string
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
        <StatusDot state={session.closed ? 'offline' : 'online'} />
        {session.closed && <span className="pane__closed">{session.closed}</span>}
        <span className="pane__spacer" />
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
