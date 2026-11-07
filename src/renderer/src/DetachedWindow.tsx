import { useEffect, useRef, useState } from 'react'
import type { StoreSnapshot } from '@shared/types'
import { Button, StatusDot, Tile } from './design/components'
import { applyTheme } from './design/themes'
import { TerminalPane, type PaneSession } from './terminal/TerminalPane'
import { closedNotice, noticeToTerminal, writeToTerminal } from './terminal/TerminalView'
import { errorText, hostTint } from './util'

/** A single session in its own OS window. Closing the window hands the session back to the main window. */
export function DetachedWindow({ session }: { session: PaneSession }) {
  const [closed, setClosed] = useState<string>()
  const [reconnecting, setReconnecting] = useState(false)
  const [address, setAddress] = useState(session.address)
  const [store, setStore] = useState<StoreSnapshot | null>(null)
  const closedRef = useRef(closed)
  closedRef.current = closed
  const busy = useRef(false)
  const attempts = useRef(0)

  useEffect(() => {
    document.title = session.title
    window.api.loadStore().then((s) => (setStore(s), applyTheme(s.settings)))
    const offData = window.api.onData(writeToTerminal)
    const offClosed = window.api.onClosed((id, reason) => {
      if (id !== session.sessionId) return
      noticeToTerminal(id, closedNotice(reason))
      setClosed(reason)
    })
    return () => (offData(), offClosed())
  }, [session])

  /** Same session id, same window: only the connection is new. */
  const reconnect = async () => {
    if (!closedRef.current || busy.current) return
    busy.current = true
    setReconnecting(true)
    noticeToTerminal(session.sessionId, `\x1b[36m[переподключение к ${address ?? session.title}…]\x1b[0m\r\n`)
    try {
      const r = await window.api.reconnect(session.sessionId, session.hostId, address)
      attempts.current = 0
      setAddress(r.address)
      setClosed(undefined)
    } catch (e) {
      noticeToTerminal(session.sessionId, `\x1b[31m[не удалось: ${errorText(e).replace(/\n/g, '\r\n')}]\x1b[0m\r\n\x1b[2mEnter или «Переподключить»: попробовать ещё раз\x1b[0m\r\n`)
    } finally {
      busy.current = false
      setReconnecting(false)
    }
  }

  // Device-side idle timeouts close the SSH transport. Retry in this same window with
  // a capped backoff, while retaining the existing terminal and its scrollback.
  useEffect(() => {
    if (!closed || reconnecting) return
    const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempts.current, 4))
    const timer = setTimeout(() => {
      attempts.current++
      void reconnect()
    }, delay)
    return () => clearTimeout(timer)
  }, [closed, reconnecting])

  const host = store?.hosts.find((h) => h.id === session.hostId)
  const tint = store && host ? hostTint(store, host) : 'blue'
  return (
    <div className="detached">
      {/* The window's own title bar; closing it returns the session to the main window. */}
      <div className="detached__chrome drag">
        <Tile tint={tint} icon="terminal" size="sm" />
        {session.title}
        <StatusDot state={reconnecting ? 'connecting' : closed ? 'offline' : 'online'} />
        {closed && <span className="muted">{reconnecting ? 'переподключаюсь…' : closed}</span>}
        {closed && (
          <Button variant="filled" size="sm" icon="reconnect" className="no-drag" disabled={reconnecting} title="Подключиться снова в этом же окне (Enter в терминале)" onClick={reconnect}>
            Переподключить
          </Button>
        )}
      </div>
      <TerminalPane
        session={{ ...session, address, closed, reconnecting }}
        tint={tint}
        visible
        focused
        inGroup={false}
        broadcasting={false}
        onFocus={() => {}}
        onInput={(id, d) => (d === '\r' && closedRef.current ? void reconnect() : window.api.write(id, d))}
        onReconnect={reconnect}
        onClose={() => (window.api.close(session.sessionId), window.close())}
      />
    </div>
  )
}
