import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Tint } from '@shared/types'
import { Button, SearchField, Tile } from '../design/components'
import { Icon, type IconName } from '../design/icons'

/**
 * A right-click menu at the pointer. Kept inside the window, closed by a click elsewhere,
 * Escape or the window losing focus.
 */
export function ContextMenu({ x, y, onClose, className, children }: { x: number; y: number; onClose(): void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) })
  }, [x, y, className])
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close.current()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    const blur = () => close.current()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return (
    <div ref={ref} className={`ds-menu__list map-context ${className ?? ''}`} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>
  )
}

export function MenuItem({ label, icon, destructive, checked, onSelect }: { label: string; icon?: IconName; destructive?: boolean; checked?: boolean; onSelect(): void }) {
  return (
    <button role="menuitem" className={`ds-menu__item ${destructive ? 'is-destructive' : ''}`} onClick={onSelect}>
      <span>{label}</span>
      {checked ? <Icon name="check" size={15} /> : icon && <Icon name={icon} size={15} />}
    </button>
  )
}

export const MenuSeparator = () => <div className="map-context__sep" role="separator" />
export const MenuHeader = ({ children }: { children: ReactNode }) => <div className="map-context__header">{children}</div>

export interface LinkCandidate {
  /** `node:<id>` for something already on the sheet, `host:<id>` for a host to place on it. */
  key: string
  name: string
  detail?: string
  icon: IconName
  tint?: Tint
  onSheet: boolean
  /** Already linked to the source node. */
  linked: boolean
}

/** Searchable list of link targets: tick one or several and link them in one go. */
export function LinkPicker({ from, candidates, onPick, onCancel }: { from: string; candidates: LinkCandidate[]; onPick(keys: string[]): void; onCancel(): void }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const search = useRef<HTMLDivElement>(null)
  useEffect(() => search.current?.querySelector('input')?.focus(), [])
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return candidates.filter((c) => !q || `${c.name} ${c.detail ?? ''}`.toLowerCase().includes(q))
  }, [candidates, query])
  const onSheet = list.filter((c) => c.onSheet)
  const offSheet = list.filter((c) => !c.onSheet)
  const toggle = (key: string) => setPicked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
  const row = (c: LinkCandidate) => (
    <button
      key={c.key}
      role="menuitemcheckbox"
      aria-checked={picked.includes(c.key)}
      className={`link-picker__item ${picked.includes(c.key) ? 'is-picked' : ''}`}
      onClick={() => toggle(c.key)}
      onDoubleClick={() => onPick([c.key])}
    >
      <Tile tint={c.tint ?? 'gray'} icon={c.icon} size="sm" />
      <span className="link-picker__name">
        {c.name}
        {c.detail && <small>{c.detail}</small>}
      </span>
      {c.linked && <span className="link-picker__badge">связан</span>}
      <span className="link-picker__check">{picked.includes(c.key) && <Icon name="check" size={14} />}</span>
    </button>
  )
  return (
    <div className="link-picker">
      <div className="link-picker__title">Связь от «{from}»</div>
      <div
        ref={search}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const keys = picked.length ? picked : list.length === 1 ? [list[0].key] : []
          if (keys.length) onPick(keys)
        }}
      >
        <SearchField value={query} onChange={setQuery} placeholder="Имя или адрес" />
      </div>
      <div className="link-picker__list">
        {onSheet.length > 0 && <MenuHeader>На этом листе</MenuHeader>}
        {onSheet.slice(0, 300).map(row)}
        {offSheet.length > 0 && <MenuHeader>Добавить на лист и связать</MenuHeader>}
        {offSheet.slice(0, 300).map(row)}
        {list.length === 0 && <p className="muted link-picker__empty">Ничего не найдено</p>}
      </div>
      <div className="link-picker__actions">
        <Button variant="plain" size="sm" onClick={onCancel}>Отмена</Button>
        <Button variant="filled" size="sm" icon="link" disabled={!picked.length} onClick={() => onPick(picked)}>
          {picked.length > 1 ? `Связать (${picked.length})` : 'Связать'}
        </Button>
      </div>
    </div>
  )
}
