import type { AnyAuthMethod, AuthHandlerMiddleware, KeyboardInteractiveAuthMethod, Prompt } from 'ssh2'

type Interactive = KeyboardInteractiveAuthMethod['prompt']
/** ssh2 takes false for "give up", its typings leave it out. */
type Next = (auth: AnyAuthMethod | false) => void

/**
 * A line typed into a session's terminal before the shell exists (login, password, "remember?").
 * Echo off for passwords, like OpenSSH: nothing is printed while typing.
 */
export class LineReader {
  private buf = ''
  private pending?: { resolve(v: string | null): void; echo: boolean }

  constructor(private out: (s: string) => void) {}

  get reading(): boolean {
    return !!this.pending
  }

  /** null: cancelled with Ctrl+C / Ctrl+D or the session went away. */
  ask(prompt: string, echo: boolean): Promise<string | null> {
    this.cancel()
    this.buf = ''
    this.out(prompt)
    return new Promise((resolve) => (this.pending = { resolve, echo }))
  }

  /** Keystrokes and pastes from the terminal. */
  feed(data: string): void {
    const p = this.pending
    if (!p) return
    // Arrows, F-keys, Home/End: nothing to do with them in a one-line prompt.
    if (data.startsWith('\x1b')) return
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        this.out('\r\n')
        return this.finish(this.buf)
      }
      if (ch === '\x03' || ch === '\x04') {
        this.out('^C\r\n')
        return this.finish(null)
      }
      if (ch === '\x7f' || ch === '\b') {
        if (!this.buf) continue
        this.buf = [...this.buf].slice(0, -1).join('')
        if (p.echo) this.out('\b \b')
        continue
      }
      if (ch === '\x15') {
        // Ctrl+U: clear the line.
        if (p.echo) this.out('\b \b'.repeat([...this.buf].length))
        this.buf = ''
        continue
      }
      if (ch < ' ') continue
      this.buf += ch
      if (p.echo) this.out(ch)
    }
  }

  cancel(): void {
    this.finish(null)
  }

  private finish(v: string | null): void {
    const p = this.pending
    this.pending = undefined
    this.buf = ''
    p?.resolve(v)
  }
}

export interface LoginIO {
  ask(prompt: string, echo: boolean): Promise<string | null>
  print(text: string): void
  /** The first time the user has to type something: the session goes on screen. */
  prompting(): void
}

/** Rounds of "login as / password" after the saved login failed; then the session gives up like a wrong password. */
export const MAX_ROUNDS = 3

export interface LoginState {
  username?: string
  password?: string
  /** The user typed the login that got in: offer to remember it. */
  typed: boolean
  /** The user pressed Ctrl+C at a prompt. */
  cancelled: boolean
}

/**
 * Auth for ssh2: the saved login first (key, password, keyboard-interactive answered with the password),
 * then, when it is missing or wrong, ask in the terminal like PuTTY ("login as:", "password:") instead of
 * failing with "Invalid username" / "Неверный логин или пароль".
 */
export function loginFlow(
  saved: { username?: string; password?: string; privateKey?: Buffer },
  hostLabel: string,
  io: LoginIO
): { authHandler: AuthHandlerMiddleware; state: LoginState } {
  const state: LoginState = { username: saved.username, password: saved.password, typed: false, cancelled: false }
  const queue: AnyAuthMethod[] = []
  /** Something was sent to the server that it turned down. */
  let tried = false
  let rounds = 0
  /** Login typed while the server's methods were unknown: "none" went first to learn them, the password is next. */
  let passwordNext = false
  const user = () => state.username ?? ''

  // "none" first, as ssh2 does by default: it lists the methods the server takes (and some take nothing).
  queue.push({ type: 'none', username: user() })
  if (saved.username) {
    if (saved.privateKey) queue.push({ type: 'publickey', username: saved.username, key: saved.privateKey })
    if (saved.password !== undefined) {
      queue.push({ type: 'password', username: saved.username, password: saved.password })
      queue.push({ type: 'keyboard-interactive', username: saved.username, prompt: answerAll(saved.password) })
    }
  }

  /** keyboard-interactive with a typed login: one password prompt takes the password, anything else is asked as is. */
  const interactive = (password: string): Interactive => (_name, instructions, _lang, prompts, finish) => {
    if (prompts.length === 1 && !prompts[0].echo) return finish([password])
    void (async () => {
      if (instructions) io.print(instructions.replace(/\r?\n/g, '\r\n') + '\r\n')
      const answers: string[] = []
      for (const p of prompts as Prompt[]) {
        const a = await io.ask(p.prompt, !!p.echo)
        if (a === null) return (state.cancelled = true), finish([])
        answers.push(a)
      }
      finish(answers)
    })()
  }

  const authHandler: AuthHandlerMiddleware = (methodsLeft, _partial, nextAuth) => {
    const next = nextAuth as Next
    const allowed = (type: string) => !methodsLeft || (methodsLeft as string[]).includes(type)
    void (async () => {
      if (state.cancelled) return next(false)
      for (let a = queue.shift(); a; a = queue.shift()) {
        // The username may have been typed after the attempt was queued.
        if (a.type === 'none') {
          if (!state.username) continue
          return next({ ...a, username: user() })
        }
        if (!allowed(a.type)) continue
        tried = true
        return next(a)
      }
      if (!(allowed('password') || allowed('keyboard-interactive'))) return next(false)
      let username = state.username
      if (passwordNext) passwordNext = false
      else {
        if (rounds >= MAX_ROUNDS) return next(false)
        rounds++
        io.prompting()
        if (tried) io.print('Доступ запрещён.\r\n')
        for (;;) {
          const u = await io.ask(username ? `login as [${username}]: ` : 'login as: ', true)
          if (u === null) return (state.cancelled = true), next(false)
          username = u.trim() || username
          if (username) break
        }
        if (!methodsLeft) {
          // Which of password / keyboard-interactive to use is known only after a first request.
          state.username = username
          passwordNext = true
          return next({ type: 'none', username: username! })
        }
      }
      const p = await io.ask(`${username}@${hostLabel}'s password: `, false)
      if (p === null) return (state.cancelled = true), next(false)
      state.username = username!
      state.password = p
      state.typed = true
      tried = true
      // One attempt per round: a switch counts every refused try against its limit.
      next(allowed('password')
        ? { type: 'password', username: username!, password: p }
        : { type: 'keyboard-interactive', username: username!, prompt: interactive(p) })
    })()
  }
  return { authHandler, state }
}

/** Saved password for every prompt (Huawei / Cisco ask for it this way). */
function answerAll(password: string): Interactive {
  return (_n, _i, _l, prompts, finish) => finish(prompts.map(() => password))
}

/** "Remember?" answer: Enter or yes; anything else is no. */
export function isYes(answer: string | null): boolean {
  return answer !== null && /^(|y|yes|д|да)$/i.test(answer.trim())
}
