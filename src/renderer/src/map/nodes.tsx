import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import type { HostIcon, HostStatus, Tint, ZoneShape } from '@shared/types'
import { HealthDot, Tile } from '../design/components'
import { formatRtt, health } from '../util'

export type HostNodeData = {
  name: string
  address: string
  tint: Tint
  icon: HostIcon
  status?: HostStatus
  sessions: number
}
export type LabelNodeData = { label: string }
export type SheetNodeData = { name: string; up: number; down: number; total: number }
export type ZoneNodeData = { name: string; shape: ZoneShape; tint: Tint; hosts: number; down: number }

export type HostFlowNode = Node<HostNodeData, 'host'>
export type LabelFlowNode = Node<LabelNodeData, 'label'>
export type SheetFlowNode = Node<SheetNodeData, 'sheet'>
export type ZoneFlowNode = Node<ZoneNodeData, 'zone'>
export type MapFlowNode = HostFlowNode | LabelFlowNode | SheetFlowNode | ZoneFlowNode

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
        <div className="map-node__addr mono">{data.address}</div>
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

export const nodeTypes = { host: HostNode, label: LabelNode, sheet: SheetNode, zone: ZoneNode }
