import { useState } from 'react'
import type { FolderKind, HostIcon, Store, Tint } from '@shared/types'
import { Group, Row, Sheet } from '../design/components'
import { FOLDER_KINDS, HOST_ICONS, plural } from '../util'
import { IconChoice, TintChoice } from './fields'

/** What to change on every picked item; 'keep' leaves that field as it is on each one. */
export interface AppearancePatch {
  tint: Tint | 'keep' | 'none'
  /** 'auto': back to the default (router for WinBox hosts, server otherwise). */
  hostIcon: HostIcon | 'keep' | 'auto'
  folderKind: FolderKind | 'keep'
}

/** Applies a patch to the picked folders and hosts; everything else stays untouched. */
export function applyAppearance<S extends Store>(store: S, folderIds: string[], hostIds: string[], p: AppearancePatch): S {
  const fs = new Set(folderIds)
  const hs = new Set(hostIds)
  const tint = (cur: Tint | undefined) => (p.tint === 'keep' ? cur : p.tint === 'none' ? undefined : p.tint)
  return {
    ...store,
    folders: store.folders.map((f) => (fs.has(f.id) ? { ...f, tint: tint(f.tint), kind: p.folderKind === 'keep' ? f.kind : p.folderKind } : f)),
    hosts: store.hosts.map((h) => (hs.has(h.id) ? { ...h, tint: tint(h.tint), icon: p.hostIcon === 'keep' ? h.icon : p.hostIcon === 'auto' ? undefined : p.hostIcon } : h))
  }
}

interface Props {
  folderCount: number
  hostCount: number
  onCancel(): void
  onApply(patch: AppearancePatch): void
}

/** One dialog for the icon and colour of everything picked with Ctrl + click. */
export function AppearanceSheet({ folderCount, hostCount, onCancel, onApply }: Props) {
  const [patch, setPatch] = useState<AppearancePatch>({ tint: 'keep', hostIcon: 'keep', folderKind: 'keep' })
  const what = [folderCount && plural(folderCount, 'папка', 'папки', 'папок'), hostCount && plural(hostCount, 'хост', 'хоста', 'хостов')].filter(Boolean).join(' и ')
  const unchanged = patch.tint === 'keep' && patch.hostIcon === 'keep' && patch.folderKind === 'keep'
  return (
    <Sheet title="Значок и цвет" onCancel={onCancel} onDone={() => onApply(patch)} doneLabel="Применить" doneDisabled={unchanged}>
      <p className="sheet-lead">
        Выбрано: <b>{what}</b>. «Не менять» оставляет у каждого своё.
      </p>
      <Group header="Цвет" footer={hostCount ? 'Хост без своего цвета берёт цвет ближайшей папки.' : 'Без цвета папка показывается серой.'}>
        <Row label={<TintChoice value={patch.tint} onChange={(tint) => setPatch({ ...patch, tint })} />} />
      </Group>
      {hostCount > 0 && (
        <Group header={folderCount ? 'Значок хостов' : 'Значок'} footer="«Авто»: роутер для хостов с WinBox, иначе сервер.">
          <Row
            label={
              <IconChoice<AppearancePatch['hostIcon']>
                label="Значок хоста"
                value={patch.hostIcon}
                onChange={(hostIcon) => setPatch({ ...patch, hostIcon })}
                options={[{ value: 'keep', label: 'Не менять', icon: 'dash' }, { value: 'auto', label: 'Авто', icon: 'server' }, ...HOST_ICONS.map((x) => ({ value: x.icon, label: x.label, icon: x.icon }))]}
              />
            }
          />
        </Group>
      )}
      {folderCount > 0 && (
        <Group header={hostCount ? 'Значок папок' : 'Значок'} footer="Тип папки меняет только значок и подсказку для новых подпапок.">
          <Row
            label={
              <IconChoice<AppearancePatch['folderKind']>
                label="Тип папки"
                value={patch.folderKind}
                onChange={(folderKind) => setPatch({ ...patch, folderKind })}
                options={[{ value: 'keep', label: 'Не менять', icon: 'dash' }, ...FOLDER_KINDS.map((k) => ({ value: k.kind, label: k.label, icon: k.icon }))]}
              />
            }
          />
        </Group>
      )}
    </Sheet>
  )
}
