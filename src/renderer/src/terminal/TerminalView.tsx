import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

interface Props {
  sessionId: string
  /** Whether this view is on screen; hidden views keep their buffer but skip fitting. */
  visible: boolean
  focused?: boolean
  /** Every keystroke; the parent decides whether it goes to one session or the broadcast group. */
  onInput(sessionId: string, data: string): void
}

/** Mounted terminals and the session offset each has written up to. */
const terminals = new Map<string, { term: Terminal; end: number }>()
/** Live chunks that arrive while a freshly mounted terminal waits for its scrollback. */
const waiting = new Map<string, { data: string; end: number }[]>()

/**
 * Live output from main. IPC events and the scrollback reply can arrive in either order,
 * so every chunk carries its end offset and anything at or before what was replayed is dropped.
 */
export function writeToTerminal(sessionId: string, data: string, end: number): void {
  const t = terminals.get(sessionId)
  if (t) {
    if (end > t.end) {
      t.term.write(data)
      t.end = end
    }
  } else waiting.get(sessionId)?.push({ data, end })
}

/** Local notices (e.g. "session closed") that are not part of the session's output. */
export function noticeToTerminal(sessionId: string, text: string): void {
  terminals.get(sessionId)?.term.write(text)
}

/** What a terminal shows when its connection is gone. */
export const closedNotice = (reason: string) =>
  `\r\n\x1b[33m[сессия закрыта: ${reason}]\x1b[0m\r\n\x1b[2mEnter или «Переподключить»: подключиться снова в этом окне\x1b[0m\r\n`

export function focusTerminal(sessionId: string): void {
  terminals.get(sessionId)?.term.focus()
}

/** Terminal colours come from the design tokens, so the terminal follows light/dark with the rest of the UI. */
function themeFromTokens(): ITheme {
  const v = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return {
    background: v('--bg-terminal'),
    foreground: v('--term-fg'),
    cursor: v('--term-cursor'),
    cursorAccent: v('--bg-terminal'),
    selectionBackground: v('--term-selection'),
    black: v('--term-black'),
    red: v('--term-red'),
    green: v('--term-green'),
    yellow: v('--term-yellow'),
    blue: v('--term-blue'),
    magenta: v('--term-magenta'),
    cyan: v('--term-cyan'),
    white: v('--term-white'),
    brightBlack: v('--term-bright-black'),
    brightRed: v('--term-red'),
    brightGreen: v('--term-green'),
    brightYellow: v('--term-yellow'),
    brightBlue: v('--term-blue'),
    brightMagenta: v('--term-magenta'),
    brightCyan: v('--term-cyan'),
    brightWhite: v('--label-1')
  }
}

export function TerminalView({ sessionId, visible, focused, onInput }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon>(null)
  const inputRef = useRef(onInput)
  inputRef.current = onInput
  const focusRef = useRef(false)
  focusRef.current = visible && !!focused

  useEffect(() => {
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
      fontSize: Number(getComputedStyle(document.documentElement).getPropertyValue('--term-font-size')) || 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: themeFromTokens()
    })
    const f = new FitAddon()
    term.loadAddon(f)
    term.open(el.current!)
    fit.current = f
    term.onData((d) => inputRef.current(sessionId, d))
    term.onResize(({ cols, rows }) => window.api.resize(sessionId, cols, rows))
    // Copy on select, paste on right click: the usual network-engineer habit from PuTTY/SecureCRT.
    term.onSelectionChange(() => term.hasSelection() && navigator.clipboard.writeText(term.getSelection()))
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      navigator.clipboard.readText().then((t) => t && inputRef.current(sessionId, t))
    }
    el.current!.addEventListener('contextmenu', onContext)

    // A view can mount long after the session started (popped-out window, window returned):
    // replay the scrollback, then the live chunks that came after it.
    let disposed = false
    waiting.set(sessionId, [])
    window.api.scrollback(sessionId).then(({ data, end }) => {
      if (disposed) return
      term.write(data)
      const entry = { term, end }
      for (const c of waiting.get(sessionId) ?? []) if (c.end > entry.end) (term.write(c.data), (entry.end = c.end))
      waiting.delete(sessionId)
      terminals.set(sessionId, entry)
      if (focusRef.current) term.focus()
    })

    const media = matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => {
      term.options.theme = themeFromTokens()
      // The design system brings its own mono font (JetBrains Mono / IBM Plex Mono).
      term.options.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
      term.options.fontSize = Number(getComputedStyle(document.documentElement).getPropertyValue('--term-font-size')) || 13
      if (el.current?.offsetParent) f.fit()
    }
    media.addEventListener('change', onScheme)
    window.addEventListener('themechange', onScheme)

    const ro = new ResizeObserver(() => el.current?.offsetParent && f.fit())
    ro.observe(el.current!)
    return () => {
      disposed = true
      ro.disconnect()
      media.removeEventListener('change', onScheme)
      window.removeEventListener('themechange', onScheme)
      if (terminals.get(sessionId)?.term === term) terminals.delete(sessionId)
      waiting.delete(sessionId)
      term.dispose()
    }
  }, [sessionId])

  useEffect(() => {
    if (visible) fit.current?.fit()
  }, [visible])

  useEffect(() => {
    if (visible && focused) terminals.get(sessionId)?.term.focus()
  }, [visible, focused, sessionId])

  return <div ref={el} className="terminal-view" style={{ display: visible ? 'block' : 'none' }} />
}
