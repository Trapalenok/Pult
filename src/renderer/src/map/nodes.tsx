import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import type { HostIcon, HostStatus, Tint, ZoneShape } from '@shared/types'
import { HealthDot, Tile } from '../design/components'
import { formatRtt, health } from '../util'

export type HostNodeData = {
  name: string
  address: string
  /** How many more addresses the host has besides the one shown. */
  more?: number
  tint: Tint
  icon: HostIcon
  status?: HostStatus
  sessions: number
}
export type LabelNodeData = { label: string }
export type SheetNodeData = { name: string; up: number; down: number; total: number }
export type ZoneNodeData = { name: string; shape: ZoneShape; tint: Tint; hosts: number; down: number }
/** url undefined: still loading, null: the file is gone. */
export type BackdropNodeData = { url?: string | null; opacity: number; unlocked: boolean }

export type HostFlowNode = Node<HostNodeData, 'host'>
export type LabelFlowNode = Node<LabelNodeData, 'label'>
export type SheetFlowNode = Node<SheetNodeData, 'sheet'>
export type ZoneFlowNode = Node<ZoneNodeData, 'zone'>
export type BackdropFlowNode = Node<BackdropNodeData, 'backdrop'>
export type MapFlowNode = HostFlowNode | LabelFlowNode | SheetFlowNode | ZoneFlowNode | BackdropFlowNode

/** Handles on all four sides; ConnectionMode.Loose lets any of them start or end a link. */
function Handles() {
  return (
    <>
      <Handle type="source" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Right} id="r" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="l" />
    </>
  )
}

export function HostNode({ data, selected }: NodeProps<HostFlowNode>) {
  const h = health(data.status)
  const t = data.status?.snmp?.ok ? data.status.snmp.temp : undefined
  return (
    <div className={`map-node map-node--${h} ${selected ? 'is-selected' : ''}`}>
      <Handles />
      <div className="map-node__icon">
        <Tile tint={data.tint} icon={data.icon} />
        <HealthDot health={h} />
      </div>
      <div className="map-node__text">
        <div className="map-node__name">{data.name}</div>
        <div className="map-node__addr mono" title={data.more ? `У хоста ещё ${data.more} адр.; показан тот, что ответил` : undefined}>{data.address}{data.more ? ` +${data.more}` : ''}</div>
        <div className="map-node__metrics">
          {h === 'down' ? <span className="bad">недоступен</span> : h === 'up' ? <span>{formatRtt(data.status?.rtt) ?? 'SNMP ok'}</span> : <span>не проверен</span>}
          {t !== undefined && <span className={t >= 70 ? 'bad' : t >= 55 ? 'warn' : ''}>{Math.round(t)}°</span>}
          {data.sessions > 0 && <span className="ssh">SSH</span>}
        </div>
      </div>
    </div>
  )
}

export function LabelNode({ data, selected }: NodeProps<LabelFlowNode>) {
  return (
    <div className={`map-label ${selected ? 'is-selected' : ''}`}>
      <Handles />
      {data.label}
    </div>
  )
}

/** A nested sheet (building, floor): double-click opens it; shows how its hosts are doing. */
export function SheetNode({ data, selected }: NodeProps<SheetFlowNode>) {
  const h = data.down > 0 ? 'down' : data.up > 0 ? 'up' : 'unknown'
  return (
    <div className={`map-node map-sheet map-node--${h} ${selected ? 'is-selected' : ''}`}>
      <Handles />
      <div className="map-node__icon">
        <Tile tint="indigo" icon="map" />
        <HealthDot health={h} />
      </div>
      <div className="map-node__text">
        <div className="map-node__name">{data.name}</div>
        <div className="map-node__addr">Лист · {data.total} {data.total === 1 ? 'хост' : data.total >= 2 && data.total <= 4 ? 'хоста' : 'хостов'}</div>
        <div className="map-node__metrics">
          <span className="ok">{data.up} в сети</span>
          {data.down > 0 && <span className="bad">{data.down} недоступно</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * A room drawn on the sheet. Only its title and frame catch the mouse: inside it the sheet pans
 * and box-selects as usual, so hosts in a room are picked like anywhere else. Dragged by the title.
 */
export function ZoneNode({ data, selected }: NodeProps<ZoneFlowNode>) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={100} keepAspectRatio={data.shape !== 'rect'} lineClassName="map-zone__line" handleClassName="map-zone__handle" />
      <div className={`map-zone map-zone--${data.shape} tint-${data.tint} ${selected ? 'is-selected' : ''} ${data.down ? 'has-down' : ''}`}>
        <div className="map-zone__title" title="Тяните за название, чтобы двигать зону вместе с хостами">
          <span className="map-zone__name">{data.name}</span>
          {data.hosts > 0 && <span className="map-zone__count">{data.down ? `${data.down} из ${data.hosts} недоступно` : data.hosts}</span>}
        </div>
      </div>
    </>
  )
}

/**
 * The sheet's backdrop picture (floor plan, site photo) under everything. Locked, it lets every
 * click through to the sheet; unlocked, it is dragged and resized (keeping its proportions) like a zone.
 */
export function BackdropNode({ data, selected }: NodeProps<BackdropFlowNode>) {
  return (
    <>
      <NodeResizer isVisible={selected && data.unlocked} minWidth={80} minHeight={60} keepAspectRatio lineClassName="map-zone__line" handleClassName="map-zone__handle" />
      <div className={`map-backdrop ${data.unlocked ? 'is-unlocked' : ''} ${selected ? 'is-selected' : ''}`} style={{ opacity: data.opacity }}>
        {data.url ? <img src={data.url} alt="" draggable={false} /> : data.url === null && <span className="map-backdrop__missing">Файл подложки не найден</span>}
      </div>
    </>
  )
}

export const nodeTypes = { host: HostNode, label: LabelNode, sheet: SheetNode, zone: ZoneNode, backdrop: BackdropNode }
