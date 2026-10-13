import { resolveLogin, snmpCommunityOwner, type Login } from '@shared/inherit'
import { snmpSecretId, type AlgoProfile, type ConnectionDefaults, type EffectiveSettings, type Folder, type FolderKind, type Host, type StoreSnapshot, type Tint } from '@shared/types'
import { Button, Field, Row, Select, Toggle } from '../design/components'
import { Icon, type IconName } from '../design/icons'
import { ALGO_LABEL, FOLDER_KINDS, TINTS, subtreeIds } from '../util'

type Flag = 'winbox' | 'ping' | 'snmp' | 'jump'

/** On/off that can also be "as above": a reset link appears once it is set on this level. */
function InheritToggle({ value, inherited, onChange, label }: { value?: boolean; inherited: boolean; onChange(v: boolean | undefined): void; label: string }) {
  return (
    <>
      {value !== undefined && (
        <Button variant="plain" size="sm" onClick={() => onChange(undefined)}>как выше</Button>
      )}
      <Toggle checked={value ?? inherited} onChange={onChange} label={label} />
    </>
  )
}

/** Inheritable connection fields, shared by the host and folder sheets. Empty = inherit. */
export function connectionRows({ value, inherited, onChange }: {
  value: ConnectionDefaults
  /** What applies if the field is left empty; shown as the placeholder. */
  inherited: EffectiveSettings
  onChange(v: ConnectionDefaults): void
}) {
  const set = <K extends keyof ConnectionDefaults>(k: K, v: ConnectionDefaults[K]) => onChange({ ...value, [k]: v })
  const algo = (value.algoProfile ?? '') as AlgoProfile | ''
  const flag = (k: Flag, label: string) => <InheritToggle value={value[k]} inherited={inherited[k]} onChange={(v) => set(k, v)} label={label} />
  return {
    port: (
      <Row label="Порт">
        <Field inputMode="numeric" value={value.port ?? ''} placeholder={String(inherited.port)} onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || undefined)} />
      </Row>
    ),
    algo: (
      <Row label="Алгоритмы">
        <Select<AlgoProfile | ''>
          value={algo}
          onChange={(v) => set('algoProfile', v || undefined)}
          options={[
            { value: '', label: `Как выше: ${ALGO_LABEL[inherited.algoProfile]}` },
            ...(['compat', 'modern', 'legacy'] as AlgoProfile[]).map((a) => ({ value: a, label: ALGO_LABEL[a] }))
          ]}
        />
      </Row>
    ),
    web: (
      <Row label="Веб-адрес">
        <Field value={value.webUrl ?? ''} placeholder={inherited.webUrl} onChange={(e) => set('webUrl', e.target.value || undefined)} />
      </Row>
    ),
    winbox: <Row label="WinBox (MikroTik)" icon="winbox" tint="teal">{flag('winbox', 'WinBox')}</Row>,
    ping: <Row label="Ping" icon="activity" tint="green">{flag('ping', 'Ping')}</Row>,
    snmp: <Row label="SNMP v2c" icon="thermometer" tint="orange">{flag('snmp', 'SNMP')}</Row>,
    jump: <Row label="Через jump-host" icon="shield" tint="purple">{flag('jump', 'Через jump-host')}</Row>
  }
}

/* ── Login: inherited, typed in, or a saved account ────────── */

export interface LoginDraft {
  mode: 'inherit' | 'manual' | 'saved'
  credentialId?: string
  username: string
  /** New password typed in; empty = keep. */
  password: string
  clearPassword: boolean
  /** Save what was typed as a reusable account. */
  saveAs: boolean
  saveName: string
}

export function initialLogin(id: string, d: ConnectionDefaults, secretIds: string[]): LoginDraft {
  const own = secretIds.includes(id)
  const mode = d.credentialId ? 'saved' : own || d.username ? 'manual' : 'inherit'
  return { mode, credentialId: d.credentialId, username: d.username ?? '', password: '', clearPassword: false, saveAs: false, saveName: '' }
}

export function describeLogin(l: Login): string {
  if (l.source?.kind === 'credential') return l.usernameOverride ? `${l.username}, пароль из учётки «${l.source.name}»` : `учётка «${l.source.name}»`
  if (l.source) return `${l.username ?? 'без логина'}, пароль из «${l.source.name}»`
  return l.username ? `${l.username}, без пароля` : 'не задано'
}

/** What a host in `folderId` would get if this level sets nothing. */
export function inheritedLogin(store: StoreSnapshot, folderId: string | null): Login {
  const probe: Host = { id: '\0', folderId, name: '', address: '', overrides: {} }
  return resolveLogin(store.folders, store.credentials, probe, store.secretIds)
}

export function LoginRows({ store, ownerId, draft, onChange, inherited }: {
  store: StoreSnapshot
  ownerId: string
  draft: LoginDraft
  onChange(d: LoginDraft): void
  inherited: Login
}) {
  const set = (p: Partial<LoginDraft>) => onChange({ ...draft, ...p })
  const hasOwn = store.secretIds.includes(ownerId) && !draft.clearPassword
  const value = draft.mode === 'saved' ? `cred:${draft.credentialId}` : draft.mode
  const cred = store.credentials.find((c) => c.id === draft.credentialId)
  return (
    <>
      <Row label="Вход" icon="key" tint="indigo">
        <Select<string>
          value={value}
          onChange={(v) => (v.startsWith('cred:') ? set({ mode: 'saved', credentialId: v.slice(5) }) : set({ mode: v as LoginDraft['mode'] }))}
          options={[
            { value: 'inherit', label: `Как выше: ${describeLogin(inherited)}` },
            ...store.credentials.map((c) => ({ value: `cred:${c.id}`, label: c.name.includes(c.username) ? c.name : `${c.name} (${c.username})` })),
            { value: 'manual', label: 'Ввести логин и пароль' }
          ]}
        />
      </Row>
      {draft.mode === 'saved' && cred && <Row label="Пользователь" detail={<span className="mono">{cred.username}</span>} />}
      {draft.mode === 'manual' && (
        <>
          <Row label="Пользователь">
            <Field value={draft.username} placeholder={inherited.username ?? 'admin'} onChange={(e) => set({ username: e.target.value })} />
          </Row>
          <Row label="Пароль" icon="lock" tint="gray">
            <Field type="password" autoComplete="new-password" value={draft.password} placeholder={hasOwn ? '•••••••• сохранён' : 'не задан'} onChange={(e) => set({ password: e.target.value })} />
            {hasOwn && !draft.password && <Button variant="plain" size="sm" onClick={() => set({ clearPassword: true })}>Сбросить</Button>}
          </Row>
          <Row label="Сохранить как учётку">
            <Toggle checked={draft.saveAs} onChange={(saveAs) => set({ saveAs })} label="Сохранить как учётку" />
          </Row>
          {draft.saveAs && (
            <Row label="Название учётки">
              <Field value={draft.saveName} placeholder={draft.username || 'Сетевики'} onChange={(e) => set({ saveName: e.target.value })} />
            </Row>
          )}
        </>
      )}
    </>
  )
}

/* ── SNMP community (secret) ───────────────────────────────── */

export function CommunityRow({ store, ownerId, probe, value, cleared, onChange, onClear }: {
  store: StoreSnapshot
  ownerId: string
  /** Host to resolve the inherited community for (the level being edited, minus itself). */
  probe: Host
  value: string
  cleared: boolean
  onChange(v: string): void
  onClear(): void
}) {
  const hasOwn = store.secretIds.includes(snmpSecretId(ownerId)) && !cleared
  const ids = store.secretIds.filter((id) => id !== snmpSecretId(ownerId))
  const from = snmpCommunityOwner(store.folders, probe, ids)
  const fromName = store.folders.find((f) => f.id === from)?.name
  return (
    <Row label="Community">
      <Field type="password" autoComplete="off" value={value} placeholder={hasOwn ? '•••••• сохранён' : fromName ? `из «${fromName}»` : 'не задан'} onChange={(e) => onChange(e.target.value)} />
      {hasOwn && !value && <Button variant="plain" size="sm" onClick={onClear}>Сбросить</Button>}
    </Row>
  )
}

/* ── Folder pickers ────────────────────────────────────────── */

export function FolderSelect({ folders, value, exclude, onChange }: { folders: Folder[]; value: string | null; exclude?: string; onChange(v: string | null): void }) {
  // A folder can't move into itself or its own subfolders.
  const banned = exclude ? subtreeIds(folders, exclude) : new Set<string>()
  const ordered: { f: Folder; depth: number }[] = []
  const walk = (parent: string | null, depth: number) =>
    folders.filter((f) => f.parentId === parent).forEach((f) => (ordered.push({ f, depth }), walk(f.id, depth + 1)))
  walk(null, 0)
  return (
    <Select<string>
      value={value ?? ''}
      onChange={(v) => onChange(v || null)}
      options={[
        { value: '', label: 'Корень' },
        ...ordered.filter(({ f }) => !banned.has(f.id)).map(({ f, depth }) => ({ value: f.id, label: `${' '.repeat(depth)}${f.name}` }))
      ]}
    />
  )
}

export function KindPicker({ value, onChange }: { value?: FolderKind; onChange(k: FolderKind): void }) {
  return (
    <div className="kind-picker" role="radiogroup" aria-label="Тип">
      {FOLDER_KINDS.map((k) => (
        <button key={k.kind} role="radio" aria-checked={(value ?? 'folder') === k.kind} className={(value ?? 'folder') === k.kind ? 'is-selected' : ''} onClick={() => onChange(k.kind)}>
          <Icon name={k.icon} size={20} />
          <span>{k.label}</span>
        </button>
      ))}
    </div>
  )
}

export function TintPicker({ value, onChange }: { value?: Tint; onChange(t: Tint | undefined): void }) {
  return (
    <div className="tint-picker" role="radiogroup" aria-label="Цвет">
      {TINTS.map((t) => (
        <button key={t} role="radio" aria-checked={value === t} aria-label={t} className={`tint-swatch tint-${t} ${value === t ? 'is-selected' : ''}`} onClick={() => onChange(value === t ? undefined : t)} />
      ))}
    </div>
  )
}

/** A grid of big icon buttons, like the folder kind picker, for any set of choices. */
export function IconChoice<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string; icon: IconName }[]; value: T; onChange(v: T): void; label: string }) {
  return (
    <div className="kind-picker icon-choice" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-selected' : ''} onClick={() => onChange(o.value)}>
          <Icon name={o.icon} size={20} />
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** Colour for many items at once: leave as is, pick one, or clear (take the folder's). */
export function TintChoice({ value, onChange, clearLabel = 'Без цвета' }: { value: Tint | 'keep' | 'none'; onChange(v: Tint | 'keep' | 'none'): void; clearLabel?: string }) {
  return (
    <div className="tint-picker tint-choice" role="radiogroup" aria-label="Цвет">
      <button role="radio" aria-checked={value === 'keep'} className={`tint-text ${value === 'keep' ? 'is-selected' : ''}`} onClick={() => onChange('keep')}>Не менять</button>
      {TINTS.map((t) => (
        <button key={t} role="radio" aria-checked={value === t} aria-label={t} className={`tint-swatch tint-${t} ${value === t ? 'is-selected' : ''}`} onClick={() => onChange(t)} />
      ))}
      <button role="radio" aria-checked={value === 'none'} className={`tint-text ${value === 'none' ? 'is-selected' : ''}`} onClick={() => onChange('none')}>{clearLabel}</button>
    </div>
  )
}
