import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import type { Tint } from '@shared/types'
import { Icon, type IconName } from './icons'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/* ── Button ────────────────────────────────────────────────── */

export type ButtonVariant = 'filled' | 'tinted' | 'plain' | 'destructive'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: IconName
}

export function Button({ variant = 'tinted', size = 'md', icon, className, children, ...rest }: ButtonProps) {
  return (
    <button className={cx('ds-btn', `ds-btn--${variant}`, `ds-btn--${size}`, !children && 'ds-btn--icon', className)} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children && <span>{children}</span>}
    </button>
  )
}

/** Borderless square icon button for toolbars and pane headers. `label` doubles as tooltip and aria-label. */
export function IconButton({ icon, label, active, className, ...rest }: { icon: IconName; label: string; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={cx('ds-iconbtn', active && 'is-active', className)} title={label} aria-label={label} aria-pressed={active} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  )
}

/* ── Badge ─────────────────────────────────────────────────── */

export function Badge({ tint = 'gray', title, children }: { tint?: Tint; title?: string; children: ReactNode }) {
  return <span className={cx('ds-badge', `tint-${tint}`)} title={title}>{children}</span>
}

/* ── Tile: the coloured rounded square from iOS Settings / Termius host list ── */

export function Tile({ tint = 'blue', icon, label, size = 'md' }: { tint?: Tint; icon?: IconName; label?: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('ds-tile', `ds-tile--${size}`, `tint-${tint}`)} aria-hidden>
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 24 : 20} /> : label?.slice(0, 2).toUpperCase()}
    </span>
  )
}

export function StatusDot({ state }: { state: 'online' | 'connecting' | 'offline' }) {
  return <span className={cx('ds-dot', `ds-dot--${state}`)} role="img" aria-label={state} />
}

/* ── Grouped list (iOS Settings) ──────────────────────────── */

export function Group({ header, footer, children }: { header?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="ds-group">
      {header && <h4 className="ds-group__header">{header}</h4>}
      <div className="ds-group__body">{children}</div>
      {footer && <p className="ds-group__footer">{footer}</p>}
    </section>
  )
}

export function Row({ label, icon, tint, detail, chevron, onClick, children }: {
  label: ReactNode
  icon?: IconName
  tint?: Tint
  detail?: ReactNode
  chevron?: boolean
  onClick?: () => void
  children?: ReactNode
}) {
  return (
    <div className={cx('ds-row', onClick && 'is-pressable')} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      {icon && <Tile icon={icon} tint={tint} size="sm" />}
      <span className="ds-row__label">{label}</span>
      <span className="ds-row__control">
        {detail && <span className="ds-row__detail">{detail}</span>}
        {children}
        {chevron && <Icon name="chevronRight" size={14} className="ds-row__chevron" />}
      </span>
    </div>
  )
}

/** Right-aligned borderless input for use inside a Row. */
export function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="ds-field" spellCheck={false} {...props} />
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <span className="ds-select">
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={12} />
    </span>
  )
}

/* ── Toggle (UISwitch) ─────────────────────────────────────── */

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label?: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={cx('ds-toggle', checked && 'is-on')} onClick={(e) => (e.stopPropagation(), onChange(!checked))}>
      <span className="ds-toggle__knob" />
    </button>
  )
}

/* ── Segmented control ─────────────────────────────────────── */

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: {
  value: T
  options: { value: T; label?: string; icon?: IconName; title?: string }[]
  onChange(v: T): void
  size?: 'sm' | 'md'
}) {
  return (
    <div className={cx('ds-seg', `ds-seg--${size}`)} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} title={o.title} className={cx('ds-seg__item', o.value === value && 'is-selected')} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={15} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── Search field ──────────────────────────────────────────── */

export function SearchField({ value, onChange, placeholder = 'Поиск' }: { value: string; onChange(v: string): void; placeholder?: string }) {
  return (
    <label className="ds-search">
      <Icon name="search" size={15} />
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onChange('')} />
      {value && (
        <button aria-label="Очистить" onClick={() => onChange('')}>
          <Icon name="xmark" size={12} />
        </button>
      )}
    </label>
  )
}

/* ── Sheet (iOS modal with Cancel / Title / Done) ──────────── */

export function Sheet({ title, onCancel, onDone, doneLabel = 'Готово', doneDisabled, doneDestructive, children }: {
  title: string
  onCancel(): void
  onDone(): void
  doneLabel?: string
  doneDisabled?: boolean
  /** The confirming action is the dangerous one (e.g. trusting a changed host key). */
  doneDestructive?: boolean
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="ds-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="ds-sheet" role="dialog" aria-modal aria-label={title}>
        <header className="ds-sheet__bar">
          <Button variant="plain" onClick={onCancel}>Отмена</Button>
          <h3>{title}</h3>
          <Button variant="plain" className={cx('is-strong', doneDestructive && 'is-destructive')} disabled={doneDisabled} onClick={onDone}>{doneLabel}</Button>
        </header>
        <div className="ds-sheet__body">{children}</div>
      </div>
    </div>
  )
}

/* ── Menu (context / ••• popover) ──────────────────────────── */

export interface MenuItem {
  label: string
  icon?: IconName
  destructive?: boolean
  onSelect(): void
}

export function MenuButton({ items, label = 'Ещё', icon = 'ellipsis' }: { items: MenuItem[]; label?: string; icon?: IconName }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="ds-menu" ref={ref} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <IconButton icon={icon} label={label} active={open} onClick={() => setOpen(!open)} />
      {open && (
        <div className="ds-menu__list" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={cx('ds-menu__item', it.destructive && 'is-destructive')} onClick={() => (setOpen(false), it.onSelect())}>
              <span>{it.label}</span>
              {it.icon && <Icon name={it.icon} size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Empty state ───────────────────────────────────────────── */

export function EmptyState({ icon, title, message, action }: { icon: IconName; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="ds-empty">
      <Icon name={icon} size={40} />
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  )
}

/* ── Banner (inline error / info) ──────────────────────────── */

export function Banner({ tint = 'red', title, children, onClose }: { tint?: Tint; title: string; children?: ReactNode; onClose?(): void }) {
  return (
    <div className={cx('ds-banner', `tint-${tint}`)} role="alert">
      <div>
        <strong>{title}</strong>
        {children && <div className="ds-banner__text">{children}</div>}
      </div>
      {onClose && <IconButton icon="xmark" label="Закрыть" onClick={onClose} />}
    </div>
  )
}

/* ── Health: status dot + sparkline for ping history ───────── */

export function HealthDot({ health, title }: { health: 'up' | 'down' | 'unknown'; title?: string }) {
  return <span className={cx('ds-health', `ds-health--${health}`)} role="img" aria-label={title ?? health} title={title} />
}

/** Ping history as bars; lost probes drawn red at full height. */
export function Sparkline({ values, width = 64, height = 18 }: { values: (number | null)[]; width?: number; height?: number }) {
  if (values.length === 0) return null
  const max = Math.max(5, ...values.map((v) => v ?? 0))
  const n = 30
  const bw = width / n
  const start = n - values.length
  return (
    <svg className="ds-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {values.map((v, i) => {
        const h = v === null ? height : Math.max(2, (v / max) * height)
        return <rect key={i} x={(start + i) * bw} y={height - h} width={Math.max(1, bw - 1)} height={h} rx={0.5} className={v === null ? 'is-lost' : ''} />
      })}
    </svg>
  )
}
