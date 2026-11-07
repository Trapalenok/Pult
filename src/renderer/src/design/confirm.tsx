import { useEffect, useState } from 'react'
import { Button } from './components'

/**
 * Questions like "Удалить хост?" in the app's own look. window.confirm() opens a Windows message box
 * captioned with the package name ("ssh-client") that ignores the theme.
 */
export interface Choice<T> {
  label: string
  value: T
  destructive?: boolean
}

interface Question {
  text: string
  /** Buttons after "Отмена", left to right; the last one is the default (Enter). */
  choices: Choice<unknown>[]
  resolve(value: unknown): void
}

let show: ((q: Question) => void) | null = null

export function ask(text: string, { ok = 'OK', destructive = false }: { ok?: string; destructive?: boolean } = {}): Promise<boolean> {
  return choose(text, [{ label: ok, value: true, destructive }]).then((v) => v === true)
}

/** Several answers besides "Отмена", which resolves to null. */
export function choose<T>(text: string, choices: Choice<T>[]): Promise<T | null> {
  return new Promise((resolve) =>
    show ? show({ text, choices, resolve: resolve as (v: unknown) => void }) : resolve(window.confirm(text) ? choices[choices.length - 1].value : null)
  )
}

/** Mounted once per window; shows queued questions one at a time on top of everything, sheets included. */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Question[]>([])
  useEffect(() => {
    show = (q) => setQueue((qs) => [...qs, q])
    return () => {
      show = null
    }
  }, [])
  const q = queue[0]
  const answer = (value: unknown) => {
    q?.resolve(value)
    setQueue((qs) => qs.slice(1))
  }
  useEffect(() => {
    if (!q) return
    // Capture phase + stop: Escape/Enter here must not also close the sheet underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return
      e.preventDefault()
      e.stopImmediatePropagation()
      answer(e.key === 'Enter' ? q.choices[q.choices.length - 1].value : null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  if (!q) return null
  return (
    <div className="ds-scrim ds-confirm-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(null)}>
      <div className="ds-sheet ds-confirm" role="alertdialog" aria-modal aria-label="Pult">
        <p className="ds-confirm__text">{q.text}</p>
        <div className={['ds-confirm__actions', q.choices.length > 1 && 'is-many'].filter(Boolean).join(' ')}>
          <Button variant="tinted" onClick={() => answer(null)}>Отмена</Button>
          {q.choices.map((c, i) => (
            <Button
              key={c.label}
              variant={i < q.choices.length - 1 ? 'tinted' : c.destructive ? 'destructive' : 'filled'}
              autoFocus={i === q.choices.length - 1}
              onClick={() => answer(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}
