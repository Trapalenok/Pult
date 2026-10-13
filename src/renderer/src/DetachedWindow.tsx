import { useEffect, useState } from 'react'
import type { StoreSnapshot } from '@shared/types'
import { StatusDot, Tile } from './design/components'
import { applyTheme } from './design/themes'
import { TerminalPane, type PaneSession } from './terminal/TerminalPane'
import { noticeToTerminal, writeToTerminal } from './terminal/TerminalView'
import { hostTint } from './util'

/** A single session in its own OS window. Closing the window hands the session back to the main window. */
export function DetachedWindow({ session }: { session: PaneSession }) {
  const [closed, setClosed] = useState<string>()
  const [store, setStore] = useState<StoreSnapshot | null>(null)

  useEffect(() => {
    document.title = session.title
    window.api.loadStore().then((s) => (setStore(s), applyTheme(s.settings)))
    const offData = window.api.onData(writeToTerminal)
    const offClosed = window.api.onClosed((id, reason) => {
      if (id !== session.sessionId) return
      noticeToTerminal(id, `\r\n\x1b[33m[сессия закрыта: ${reason}]\x1b[0m\r\n`)
      setClosed(reason)
    })
    return () => (offData(), offClosed())
  }, [session])

  const host = store?.hosts.find((h) => h.id === session.hostId)
  const tint = store && host ? hostTint(store, host) : 'blue'
  return (
    <div className="detached">
      {/* The window's own title bar; closing it returns the session to the main window. */}
      <div className="detached__chrome drag">
        <Tile tint={tint} icon="terminal" size="sm" />
        {session.title}
        <StatusDot state={closed ? 'offline' : 'online'} />
        {closed && <span className="muted">{closed}</span>}
      </div>
      <TerminalPane
        session={{ ...session, closed }}
        tint={tint}
        visible
        focused
        inGroup={false}
        broadcasting={false}
        onFocus={() => {}}
        onInput={(id, d) => window.api.write(id, d)}
        onClose={() => (window.api.close(session.sessionId), window.close())}
      />
    </div>
  )
}
