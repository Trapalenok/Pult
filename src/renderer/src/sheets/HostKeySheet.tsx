import type { HostKeyPrompt } from '@shared/types'
import { Banner, Button, Group, Row, Sheet } from '../design/components'

/**
 * Shown before the first login to a host, and loudly when its key changed. Nothing is
 * trusted unless the user presses the button.
 */
export function HostKeySheet({ prompt, queued, onAnswer, onTrustAllNew }: {
  prompt: HostKeyPrompt
  /** More new-key prompts waiting (e.g. "connect to all" in a new room). */
  queued: number
  onAnswer(accept: boolean): void
  onTrustAllNew(): void
}) {
  const changed = !!prompt.previous
  return (
    <Sheet
      title={changed ? 'Ключ хоста изменился' : 'Новый хост'}
      onCancel={() => onAnswer(false)}
      onDone={() => onAnswer(true)}
      doneLabel={changed ? 'Всё равно доверять' : 'Доверять'}
      doneDestructive={changed}
    >
      {changed ? (
        <div className="sheet-banner">
          <Banner title="Возможна подмена устройства">
            Ключ {prompt.hostName} не совпадает с сохранённым. Так бывает после замены коммутатора или сброса конфигурации, но так же выглядит и перехват соединения. Подключайтесь, только если знаете причину.
          </Banner>
        </div>
      ) : (
        <p className="sheet-lead">
          Вы подключаетесь к <b>{prompt.hostName}</b> впервые. Сверьте отпечаток с выводом на устройстве
          (<span className="mono">display ssh server-info</span> / <span className="mono">/ip ssh print</span>) и подтвердите.
        </p>
      )}
      <Group>
        <Row label="Адрес" detail={<span className="mono">{prompt.address}:{prompt.port}</span>} />
        <Row label="Тип ключа" detail={<span className="mono">{prompt.keyType}</span>} />
        <Row label={changed ? 'Новый отпечаток' : 'Отпечаток'} detail={<span className="mono fingerprint">{prompt.fingerprint}</span>} />
        {prompt.previous && (
          <Row label="Был" detail={<span className="mono fingerprint">{prompt.previous.fingerprint}</span>} />
        )}
      </Group>
      {!changed && queued > 0 && (
        <div className="sheet-danger">
          <Button variant="tinted" icon="check" onClick={onTrustAllNew}>Доверять всем новым ({queued + 1})</Button>
          <p className="muted">Только для впервые встреченных хостов; изменённые ключи всё равно спросятся.</p>
        </div>
      )}
    </Sheet>
  )
}
