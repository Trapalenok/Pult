import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react'
import type { LinkShape } from '@shared/types'
import type { Health } from '../util'

export type LinkEdgeData = {
  shape: LinkShape
  bend?: { x: number; y: number }
  text?: string
  health: Health
  /** Live position while the bend handle is dragged; persisted when released. */
  onBend(id: string, bend: { x: number; y: number } | undefined, done: boolean): void
}
export type LinkFlowEdge = Edge<LinkEdgeData, 'link'>

/**
 * A link the user can shape: curve, straight or step, plus a bend point dragged from the
 * handle in the middle of a selected link (double-click the handle to straighten it again).
 */
export function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps<LinkFlowEdge>) {
  const flow = useReactFlow()
  const shape = data?.shape ?? 'curve'
  const mid = { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }
  const bend = data?.bend
  // The point the line passes through: the midpoint, moved by the bend.
  const p = bend ? { x: mid.x + bend.x, y: mid.y + bend.y } : mid
  let path: string
  let label = p
  if (shape === 'step') {
    const [d, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10, centerX: p.x, centerY: p.y })
    path = d
    label = { x: lx, y: ly }
  } else if (shape === 'straight') {
    path = bend ? `M ${sourceX},${sourceY} L ${p.x},${p.y} L ${targetX},${targetY}` : `M ${sourceX},${sourceY} L ${targetX},${targetY}`
  } else {
    // Quadratic curve through p: control point = 2p − (s + t) / 2. Without a bend, a gentle S.
    path = bend
      ? `M ${sourceX},${sourceY} Q ${2 * p.x - mid.x},${2 * p.y - mid.y} ${targetX},${targetY}`
      : `M ${sourceX},${sourceY} C ${sourceX},${mid.y} ${targetX},${mid.y} ${targetX},${targetY}`
    if (Math.abs(targetY - sourceY) < Math.abs(targetX - sourceX) && !bend) path = `M ${sourceX},${sourceY} C ${mid.x},${sourceY} ${mid.x},${targetY} ${targetX},${targetY}`
  }

  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const at = (ev: PointerEvent | React.PointerEvent) => {
      const f = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      return { x: Math.round(f.x - mid.x), y: Math.round(f.y - mid.y) }
    }
    const move = (ev: PointerEvent) => data?.onBend(id, at(ev), false)
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      data?.onBend(id, at(ev), true)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {data?.health === 'up' && <path className="map-edge__flow" d={path} />}
      <EdgeLabelRenderer>
        {data?.text && (
          <div className="map-edge__label nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y + (selected ? 18 : 0)}px)` }}>
            {data.text}
          </div>
        )}
        {selected && (
          <div
            className="map-edge__bend nodrag nopan"
            title="Тяните, чтобы изогнуть линию; двойной клик выпрямляет"
            style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}
            onPointerDown={startDrag}
            onDoubleClick={(e) => (e.stopPropagation(), data?.onBend(id, undefined, true))}
          />
        )}
      </EdgeLabelRenderer>
    </>
  )
}

export const edgeTypes = { link: LinkEdge }
