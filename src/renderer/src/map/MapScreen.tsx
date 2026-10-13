import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
  type OnSelectionChangeParams
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { effectiveSettings } from '@shared/inherit'
import type { HostStatus, LinkShape, MapLink, MapNode, MapZone, NetMap, StoreSnapshot, ZoneShape } from '@shared/types'
import { Button, EmptyState, Field, Group, IconButton, MenuButton, Row, SearchField, Segmented, Sheet, Tile } from '../design/components'
import { Icon } from '../design/icons'
import { folderPath, health, healthSummary, hostIcon, hostTint, newId, TINTS, type Health } from '../util'
import { ContextMenu, LinkPicker, MenuHeader, MenuItem, MenuSeparator, type LinkCandidate } from './ContextMenu'
import { TintPicker } from '../sheets/fields'
import { edgeTypes, type LinkFlowEdge } from './edges'
import { LinkSheet } from './LinkSheet'
import { nodeTypes, type MapFlowNode } from './nodes'
import { withShape, ZONE_SHAPES, ZoneSheet } from './ZoneSheet'

interface Props {
  store: StoreSnapshot
  status: Map<string, HostStatus>
  openCount: Map<string, number>
  onSaveMaps(maps: NetMap[]): void
  onConnect(hostId: string): void
  /** Several hosts at once: opened side by side and grouped for broadcast. */
  /** title: the tab the sessions open in together. */
  onConnectMany(hostIds: string[], title?: string): void
  onBrowser(hostId: string): void
  onWinbox(hostId: string): void
  onTools?(hostId: string): void
  onEditHost(hostId: string): void
  /** Icon and colour for several hosts at once. */
  onAppearance(hostIds: string[]): void
  /** Blinking LEDs and traffic along links. */
  animations: boolean
}

export function MapScreen(p: Props) {
  return (
    <ReactFlowProvider>
      <MapWorkspace {...p} />
    </ReactFlowProvider>
  )
}

const DRAG_TYPE = 'application/x-ssh-host'

function MapWorkspace(p: Props) {
  const { store, status } = p
  const maps = store.maps
  const tabs = maps.filter((m) => !m.parentId || !maps.some((x) => x.id === m.parentId))
  const [activeId, setActiveId] = useState<string | null>(tabs[0]?.id ?? null)
  const active = maps.find((m) => m.id === activeId) ?? tabs[0]
  /** Root tab → … → active sheet. */
  const trail = useMemo(() => {
    const t: NetMap[] = []
    for (let m: NetMap | undefined = active; m && !t.includes(m); m = maps.find((x) => x.id === m!.parentId)) t.unshift(m)
    return t
  }, [active, maps])
  /** Hosts on a sheet and on every sheet nested in it. */
  const sheetHosts = (mapId: string, seen = new Set<string>()): string[] => {
    const m = maps.find((x) => x.id === mapId)
    if (!m || seen.has(mapId)) return []
    seen.add(mapId)
    return [...new Set(m.nodes.flatMap((n) => (n.hostId ? [n.hostId] : n.sheetId ? sheetHosts(n.sheetId, seen) : [])))]
  }
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set())
  const [bendDraft, setBendDraft] = useState<{ id: string; bend?: { x: number; y: number } } | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  // React Flow re-fires onSelectionChange whenever the callback identity changes, so it must be
  // stable and must not set a new array for the same selection, or the two feed each other forever
  // (the renderer locks up and the window goes black as soon as a link is dragged).
  const onSelectionChange = useCallback(({ nodes: ns }: OnSelectionChangeParams) => {
    setSelected((cur) => {
      const ids = ns.map((n) => n.id)
      return ids.length === cur.length && ids.every((id, i) => id === cur[i]) ? cur : ids
    })
  }, [])
  /** Right-click menu on a node or a link; `pick` turns the node menu into the link-target picker. */
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string; pick?: boolean } | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; linkId: string } | null>(null)
  const [editingLink, setEditingLink] = useState<MapLink | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  // window.prompt() does not exist in Electron; labels are edited in a sheet.
  const [labelEdit, setLabelEdit] = useState<{ nodeId: string; text: string } | null>(null)
  /** Right-click on empty sheet: add a zone or a label there. */
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingZone, setEditingZone] = useState<MapZone | null>(null)
  /** Box mode: dragging on the sheet draws a selection frame; the middle button pans. */
  const [boxMode, setBoxMode] = useState(false)
  /** Set by drag stop / resize end; the next render (with final positions) writes them to the store. */
  const [pendingLayout, setPendingLayout] = useState<{ rezone: string[] | 'all' } | null>(null)
  const flow = useReactFlow()

  const hostsById = useMemo(() => new Map(store.hosts.map((h) => [h.id, h])), [store.hosts])

  // Live positions while dragging; persisted on drag stop.
  const [nodes, setNodes] = useState<MapFlowNode[]>([])
  useEffect(() => {
    if (!active) return setNodes([])
    setNodes((prev) => {
      const sel = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      // Status updates arrive every few seconds; a node being dragged or resized keeps its live place.
      const live = new Map(prev.filter((n) => n.dragging || n.resizing).map((n) => [n.id, n]))
      const zones = active.zones ?? []
      const zoneById = new Map(zones.map((z) => [z.id, z]))
      const zoneNodes = zones.map((z): MapFlowNode => {
        const inside = active.nodes.filter((n) => n.zoneId === z.id && n.hostId).map((n) => n.hostId!)
        const sum = healthSummary(inside, status)
        return {
          id: z.id,
          type: 'zone',
          position: { x: z.x, y: z.y },
          width: z.w,
          height: z.h,
          // Behind everything, even when selected (selection adds 1000).
          zIndex: -1000,
          style: { pointerEvents: 'none' },
          dragHandle: '.map-zone__title',
          selected: sel.has(z.id),
          data: { name: z.name, shape: z.shape, tint: z.tint ?? 'gray', hosts: inside.length, down: sum.down }
        }
      })
      const built = active.nodes.map((n): MapFlowNode => {
        const child = n.sheetId ? maps.find((x) => x.id === n.sheetId) : undefined
        if (child) {
          const ids = sheetHosts(child.id)
          const sum = healthSummary(ids, status)
          return { id: n.id, type: 'sheet', position: { x: n.x, y: n.y }, selected: sel.has(n.id), data: { name: child.name, up: sum.up, down: sum.down, total: ids.length } }
        }
        const h = n.hostId ? hostsById.get(n.hostId) : undefined
        if (!h) return { id: n.id, type: 'label', position: { x: n.x, y: n.y }, data: { label: n.label ?? (n.hostId ? 'хост удалён' : 'Подпись') }, selected: sel.has(n.id) }
        return {
          id: n.id,
          type: 'host',
          position: { x: n.x, y: n.y },
          selected: sel.has(n.id),
          data: {
            name: h.name,
            address: h.address,
            tint: hostTint(store, h),
            icon: hostIcon(store, h),
            status: status.get(h.id),
            sessions: p.openCount.get(h.id) ?? 0
          }
        }
      })
      // A node in a zone is its child: React Flow moves it with the zone and wants it relative.
      const placed = built.map((fn): MapFlowNode => {
        const z = zoneById.get(active.nodes.find((n) => n.id === fn.id)?.zoneId ?? '')
        return z ? { ...fn, parentId: z.id, position: { x: fn.position.x - z.x, y: fn.position.y - z.y } } : fn
      })
      // Parents must come before their children.
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const next = [...zoneNodes, ...placed].map((fn): MapFlowNode => {
        const l = live.get(fn.id)
        if (l) return { ...fn, position: l.position, parentId: l.parentId, ...(fn.type === 'zone' ? { width: l.width, height: l.height } : {}), measured: l.measured, dragging: l.dragging, resizing: l.resizing } as MapFlowNode
        const old = prevById.get(fn.id)
        if (!old) return fn
        // The same node as before keeps its object, so React Flow neither re-renders nor re-measures it;
        // a changed one keeps its measured size, or it is hidden until measured again (the map flickered).
        if (sameNode(old, fn)) return old
        return { ...fn, measured: old.measured } as MapFlowNode
      })
      return next.length === prev.length && next.every((n, i) => n === prev[i]) ? prev : next
    })
  }, [active, hostsById, status, store, p.openCount, maps])

  // A freshly opened sheet gets fresh numbers instead of waiting for the next round.
  useEffect(() => {
    const ids = active ? sheetHosts(active.id) : []
    if (ids.length) window.api.monitorProbe(ids)
  }, [active?.id])

  const nodeHost = (nodeId: string) => active?.nodes.find((n) => n.id === nodeId)?.hostId
  const nodeSheet = (nodeId: string) => active?.nodes.find((n) => n.id === nodeId)?.sheetId
  const nodeHealth = (nodeId: string): Health => {
    const h = nodeHost(nodeId)
    if (h) return health(status.get(h))
    const sh = nodeSheet(nodeId)
    if (!sh) return 'unknown'
    const sum = healthSummary(sheetHosts(sh), status)
    return sum.down ? 'down' : sum.up ? 'up' : 'unknown'
  }
  const updateMap = (fn: (m: NetMap) => NetMap) => active && p.onSaveMaps(maps.map((m) => (m.id === active.id ? fn(m) : m)))

  const onBend = (id: string, bend: { x: number; y: number } | undefined, done: boolean) => {
    if (!done) return setBendDraft({ id, bend })
    setBendDraft(null)
    updateMap((m) => ({ ...m, links: m.links.map((l) => (l.id === id ? { ...l, bend } : l)) }))
  }

  /** Where each node is on the sheet (children of a zone hold positions relative to it). */
  const absolute = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const m = new Map<string, { x: number; y: number }>()
    nodes.forEach((n) => {
      const parent = n.parentId ? byId.get(n.parentId) : undefined
      m.set(n.id, parent ? { x: parent.position.x + n.position.x, y: parent.position.y + n.position.y } : n.position)
    })
    return m
  }, [nodes])

  // Links attach to the facing sides of their nodes, so a line never loops around a node.
  const center = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    nodes.forEach((n) => {
      const a = absolute.get(n.id)!
      m.set(n.id, { x: a.x + (n.measured?.width ?? 200) / 2, y: a.y + (n.measured?.height ?? 70) / 2 })
    })
    return m
  }, [nodes, absolute])
  const sides = (from: string, to: string) => {
    const a = center.get(from), b = center.get(to)
    if (!a || !b) return {}
    const dx = b.x - a.x, dy = b.y - a.y
    if (Math.abs(dx) > Math.abs(dy) * 1.5) return dx > 0 ? { sourceHandle: 'r', targetHandle: 'l' } : { sourceHandle: 'l', targetHandle: 'r' }
    return dy > 0 ? { sourceHandle: 'b', targetHandle: 't' } : { sourceHandle: 't', targetHandle: 'b' }
  }
  const edges: LinkFlowEdge[] = useMemo(() => {
    if (!active) return []
    return active.links.map((l) => {
      const a = nodeHealth(l.from)
      const b = nodeHealth(l.to)
      const state: Health = a === 'down' || b === 'down' ? 'down' : a === 'up' && b === 'up' ? 'up' : 'unknown'
      const ifs = [l.fromIf, l.toIf].some(Boolean) ? `${l.fromIf ?? '?'} ↔ ${l.toIf ?? '?'}` : ''
      const text = [ifs, l.label].filter(Boolean).join(' · ')
      return {
        id: l.id,
        type: 'link',
        source: l.from,
        target: l.to,
        ...sides(l.from, l.to),
        className: `map-edge is-${state}`,
        selected: selectedEdges.has(l.id),
        data: { shape: l.shape ?? 'curve', bend: bendDraft?.id === l.id ? bendDraft.bend : l.bend, text: text || undefined, health: state, onBend }
      }
    })
  }, [active, status, center, bendDraft, maps, selectedEdges])


  /** Node titles as shown on the sheet. */
  const nodeTitle = (nodeId: string) => {
    const n = active?.nodes.find((x) => x.id === nodeId)
    const child = n?.sheetId ? maps.find((x) => x.id === n.sheetId) : undefined
    return child?.name ?? (n?.hostId && hostsById.get(n.hostId)?.name) ?? n?.label ?? 'Подпись'
  }

  /** Everything the node can be linked to: other nodes on the sheet, then hosts not on it yet. */
  const linkCandidates = (nodeId: string): LinkCandidate[] => {
    if (!active) return []
    const linked = new Set(active.links.flatMap((l) => (l.from === nodeId ? [l.to] : l.to === nodeId ? [l.from] : [])))
    const here: LinkCandidate[] = active.nodes
      .filter((n) => n.id !== nodeId)
      .map((n): LinkCandidate => {
        const h = n.hostId ? hostsById.get(n.hostId) : undefined
        return {
          key: `node:${n.id}`,
          name: nodeTitle(n.id),
          detail: h?.address,
          icon: n.sheetId ? 'map' : h ? 'server' : 'textNode',
          tint: h ? hostTint(store, h) : n.sheetId ? 'indigo' : 'gray',
          onSheet: true,
          linked: linked.has(n.id)
        }
      })
      .sort((a, b) => Number(a.linked) - Number(b.linked) || a.name.localeCompare(b.name))
    const placed = new Set(active.nodes.map((n) => n.hostId))
    const away: LinkCandidate[] = store.hosts
      .filter((h) => !placed.has(h.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((h): LinkCandidate => ({ key: `host:${h.id}`, name: h.name, detail: h.folderId ? `${h.address} · ${folderPath(store.folders, h.folderId)}` : h.address, icon: 'server', tint: hostTint(store, h), onSheet: false, linked: false }))
    return [...here, ...away]
  }

  /** Links the node to the picked targets; hosts not on the sheet are placed in a column beside it. */
  const linkTo = (nodeId: string, keys: string[]) => {
    if (!active) return
    const src = active.nodes.find((n) => n.id === nodeId)
    if (!src) return
    // Free spots nearest to the node, right-hand side first, so new hosts never cover existing ones.
    const taken = nodes.filter((n) => n.type !== 'zone').map((n) => ({ ...absolute.get(n.id)!, w: n.measured?.width ?? 200, h: n.measured?.height ?? 70 }))
    const cells: { x: number; y: number; d: number }[] = []
    for (let dx = -6; dx <= 6; dx++) for (let dy = -8; dy <= 8; dy++) if (dx || dy) cells.push({ x: src.x + dx * 260, y: src.y + dy * 110, d: Math.abs(dx) + Math.abs(dy) * 0.6 + (dx < 0 ? 0.5 : 0) })
    cells.sort((a, b) => a.d - b.d)
    const free = (c: { x: number; y: number }) => !taken.some((t) => c.x < t.x + t.w + 30 && c.x + 230 > t.x && c.y < t.y + t.h + 30 && c.y + 100 > t.y)
    const placed: MapNode[] = keys
      .filter((k) => k.startsWith('host:'))
      .map((k) => {
        const c = cells.find(free) ?? { x: src.x + 260, y: src.y + taken.length * 20 }
        taken.push({ x: c.x, y: c.y, w: 200, h: 70 })
        return { id: newId(), hostId: k.slice(5), x: Math.round(c.x / 10) * 10, y: Math.round(c.y / 10) * 10 }
      })
    const targets = [...keys.filter((k) => k.startsWith('node:')).map((k) => k.slice(5)), ...placed.map((n) => n.id)]
    const links: MapLink[] = targets.map((to) => ({ id: newId(), from: nodeId, to }))
    updateMap((m) => ({ ...m, nodes: [...m.nodes, ...placed], links: [...m.links, ...links] }))
    if (placed.length) window.api.monitorProbe(placed.map((n) => n.hostId!))
    // One link: straight into its sheet, so the ports can be typed right away.
    if (links.length === 1) setEditingLink(links[0])
  }

  const updateLink = (id: string, patch: Partial<MapLink>) => updateMap((m) => ({ ...m, links: m.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }))
  const deleteLink = (id: string) => updateMap((m) => ({ ...m, links: m.links.filter((l) => l.id !== id) }))

  const addSheet = () => {
    const m: NetMap = { id: newId(), name: `Лист ${tabs.length + 1}`, nodes: [], links: [] }
    p.onSaveMaps([...maps, m])
    setActiveId(m.id)
  }

  /** A sheet inside the current one, shown on it as a node that opens it. */
  const addChildSheet = () => {
    if (!active) return
    const child: NetMap = { id: newId(), name: `Вложенный лист ${maps.filter((m) => m.parentId === active.id).length + 1}`, parentId: active.id, nodes: [], links: [] }
    const at = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    p.onSaveMaps([...maps.map((m) => (m.id === active.id ? { ...m, nodes: [...m.nodes, { id: newId(), sheetId: child.id, x: Math.round(at.x - 100), y: Math.round(at.y - 35) }] } : m)), child])
  }

  /** The sheet, everything nested in it, and the nodes pointing at them. */
  const withoutSheets = (list: NetMap[], rootIds: string[]): NetMap[] => {
    const gone = new Set<string>()
    const walk = (id: string) => (gone.add(id), list.filter((m) => m.parentId === id).forEach((m) => walk(m.id)))
    rootIds.forEach(walk)
    return list
      .filter((m) => !gone.has(m.id))
      .map((m) => {
        const dead = new Set(m.nodes.filter((n) => n.sheetId && gone.has(n.sheetId)).map((n) => n.id))
        return dead.size ? { ...m, nodes: m.nodes.filter((n) => !dead.has(n.id)), links: m.links.filter((l) => !dead.has(l.from) && !dead.has(l.to)) } : m
      })
  }

  const deleteSheet = (sheet: NetMap) => {
    if (!confirm(`Удалить лист «${sheet.name}» и все вложенные в него листы?`)) return
    p.onSaveMaps(withoutSheets(maps, [sheet.id]))
    setActiveId(sheet.parentId ?? tabs.find((t) => t.id !== sheet.id)?.id ?? null)
  }

  const onNodesChange = (changes: NodeChange<MapFlowNode>[]) => {
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    const zoneIds = new Set((active?.zones ?? []).map((z) => z.id))
    setNodes((ns) => {
      let next = applyNodeChanges(changes, ns)
      // Children of a removed zone stay where they are, on the sheet itself.
      const goneZones = new Map(ns.filter((n) => removed.includes(n.id) && n.type === 'zone').map((n) => [n.id, n.position]))
      if (goneZones.size)
        next = next.map((n) => {
          const at = n.parentId ? goneZones.get(n.parentId) : undefined
          return at ? ({ ...n, parentId: undefined, position: { x: at.x + n.position.x, y: at.y + n.position.y } } as MapFlowNode) : n
        })
      return next
    })
    if (removed.length) removeNodes(removed)
    // A finished resize of a zone: save it and let nodes now inside it join (and those outside leave).
    if (changes.some((c) => c.type === 'dimensions' && c.resizing === false && zoneIds.has(c.id))) setPendingLayout({ rezone: 'all' })
  }

  const removeNodes = (ids: string[]) => {
    if (!active) return
    // A removed zone lets its nodes go: they stay on the sheet where they are.
    const zoneGone = new Set(ids.filter((id) => active.zones?.some((z) => z.id === id)))
    const gone = new Set(ids.filter((id) => !zoneGone.has(id)))
    const sheets = active.nodes.filter((n) => gone.has(n.id) && n.sheetId).map((n) => n.sheetId!)
    if (sheets.length && !confirm(`Вместе с узлом удалится вложенный лист (${sheets.map((id) => maps.find((m) => m.id === id)?.name).join(', ')}) со всем содержимым. Удалить?`)) return
    const next = maps.map((m) =>
      m.id === active.id
        ? {
            ...m,
            zones: zoneGone.size ? (m.zones ?? []).filter((z) => !zoneGone.has(z.id)) : m.zones,
            nodes: m.nodes.filter((n) => !gone.has(n.id)).map((n) => (n.zoneId && zoneGone.has(n.zoneId) ? { ...n, zoneId: undefined } : n)),
            links: m.links.filter((l) => !gone.has(l.from) && !gone.has(l.to))
          }
        : m
    )
    p.onSaveMaps(sheets.length ? withoutSheets(next, sheets) : next)
    setSelected([])
  }

  /** The zone a point falls in; the smallest one when zones overlap. */
  const zoneAt = (pt: { x: number; y: number }) => {
    const hit = nodes.filter((z) => {
      if (z.type !== 'zone') return false
      const { x, y } = z.position
      const w = z.width ?? 0, h = z.height ?? 0
      if (z.data.shape === 'circle') return ((pt.x - x - w / 2) / (w / 2)) ** 2 + ((pt.y - y - h / 2) / (h / 2)) ** 2 <= 1
      return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h
    })
    return hit.sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0))[0]?.id
  }

  /** Writes positions and zone sizes; nodes in `rezone` join the zone they now sit in (or leave theirs). */
  const persistLayout = (rezone: string[] | 'all') => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const check = (id: string) => rezone === 'all' || rezone.includes(id)
    updateMap((m) => ({
      ...m,
      zones: (m.zones ?? []).map((z) => {
        const f = byId.get(z.id)
        return f ? { ...z, x: Math.round(f.position.x), y: Math.round(f.position.y), w: Math.round(f.width ?? z.w), h: Math.round(f.height ?? z.h) } : z
      }),
      nodes: m.nodes.map((n) => {
        const f = byId.get(n.id)
        const at = absolute.get(n.id)
        if (!f || !at) return n
        const zoneId = check(n.id) ? zoneAt({ x: at.x + (f.measured?.width ?? 200) / 2, y: at.y + (f.measured?.height ?? 70) / 2 }) : n.zoneId
        return { ...n, x: Math.round(at.x), y: Math.round(at.y), zoneId }
      })
    }))
  }
  useEffect(() => {
    if (!pendingLayout) return
    setPendingLayout(null)
    persistLayout(pendingLayout.rezone)
  }, [pendingLayout])
  const onDragStop = (_e: unknown, _n: unknown, dragged: MapFlowNode[]) => setPendingLayout({ rezone: dragged.filter((n) => n.type !== 'zone').map((n) => n.id) })

  /** Default size of a new zone. */
  const ZONE_SIZE: Record<ZoneShape, { w: number; h: number }> = { rect: { w: 560, h: 340 }, square: { w: 400, h: 400 }, circle: { w: 420, h: 420 } }

  /**
   * A new zone: around the selected nodes when there are any (they go into it), otherwise centred
   * on `at` (sheet coordinates), taking in whatever already stands inside it. Opens its sheet to name it.
   */
  const addZone = (shape: ZoneShape, at?: { x: number; y: number }) => {
    if (!active) return
    const picked = nodes.filter((n) => n.selected && n.type !== 'zone')
    let box: { x: number; y: number; w: number; h: number }
    if (picked.length && !at) {
      const xs = picked.map((n) => absolute.get(n.id)!.x), ys = picked.map((n) => absolute.get(n.id)!.y)
      const x2 = Math.max(...picked.map((n) => absolute.get(n.id)!.x + (n.measured?.width ?? 200)))
      const y2 = Math.max(...picked.map((n) => absolute.get(n.id)!.y + (n.measured?.height ?? 70)))
      // Room for the title on top and a margin around.
      box = { x: Math.min(...xs) - 40, y: Math.min(...ys) - 70, w: x2 - Math.min(...xs) + 80, h: y2 - Math.min(...ys) + 110 }
      if (shape !== 'rect') {
        // A circle has to reach the corners of the box, a square only needs equal sides.
        const side = Math.max(box.w, box.h) * (shape === 'circle' ? 1.42 : 1)
        box = { x: box.x + box.w / 2 - side / 2, y: box.y + box.h / 2 - side / 2, w: side, h: side }
      }
    } else {
      const c = at ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      box = { x: c.x - ZONE_SIZE[shape].w / 2, y: c.y - ZONE_SIZE[shape].h / 2, ...ZONE_SIZE[shape] }
    }
    const count = active.zones?.length ?? 0
    const zone: MapZone = { id: newId(), name: `Зона ${count + 1}`, shape, tint: TINTS[(count + 6) % TINTS.length], x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
    const around = picked.length > 0 && !at
    const inside = (n: MapNode) => {
      if (around) return picked.some((x) => x.id === n.id)
      if (n.zoneId) return false
      const f = nodes.find((x) => x.id === n.id)
      const cx = n.x + (f?.measured?.width ?? 200) / 2 - zone.x - zone.w / 2, cy = n.y + (f?.measured?.height ?? 70) / 2 - zone.y - zone.h / 2
      return shape === 'circle' ? (cx / (zone.w / 2)) ** 2 + (cy / (zone.h / 2)) ** 2 <= 1 : Math.abs(cx) <= zone.w / 2 && Math.abs(cy) <= zone.h / 2
    }
    updateMap((m) => ({ ...m, zones: [...(m.zones ?? []), zone], nodes: m.nodes.map((n) => (inside(n) ? { ...n, zoneId: zone.id } : n)) }))
    setEditingZone(zone)
  }

  const saveZone = (z: MapZone) => updateMap((m) => ({ ...m, zones: (m.zones ?? []).map((x) => (x.id === z.id ? z : x)) }))
  const zoneNodeIds = (zoneId: string) => active?.nodes.filter((n) => n.zoneId === zoneId).map((n) => n.id) ?? []
  const zoneHosts = (zoneId: string) => active?.nodes.filter((n) => n.zoneId === zoneId && n.hostId).map((n) => n.hostId!) ?? []
  const selectOnly = (ids: string[]) => {
    const want = new Set(ids)
    setNodes((ns) => ns.map((n) => (!!n.selected === want.has(n.id) ? n : { ...n, selected: want.has(n.id) })))
  }

  const addNode = (node: Omit<MapNode, 'id'>) => updateMap((m) => ({ ...m, nodes: [...m.nodes, { id: newId(), ...node }] }))

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const hostId = e.dataTransfer.getData(DRAG_TYPE)
    if (!hostId || !active) return
    const { x, y } = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode({ hostId, x: Math.round(x - 90), y: Math.round(y - 30) })
    window.api.monitorProbe([hostId])
  }

  const selectedHosts = selected.map(nodeHost).filter((x): x is string => !!x)
  const menuZone = menu ? active?.zones?.find((z) => z.id === menu.nodeId) : undefined
  const onMap = new Set(active?.nodes.map((n) => n.hostId))
  const palette = store.hosts
    .filter((h) => `${h.name} ${h.address}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(onMap.has(a.id)) - Number(onMap.has(b.id)) || a.name.localeCompare(b.name))
  const sum = healthSummary(active ? sheetHosts(active.id) : [], status)
  const menuSheet = menu ? nodeSheet(menu.nodeId) : undefined
  const menuHost = menu ? nodeHost(menu.nodeId) : undefined
  const menuNode = menu ? active?.nodes.find((n) => n.id === menu.nodeId) : undefined
  /** Ctrl + A: every node on the sheet (zones too, so the whole sheet can be moved). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyA' || (e.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return
      if (!(e.target as HTMLElement).closest('.map-canvas') && document.activeElement !== document.body) return
      e.preventDefault()
      selectOnly(nodes.filter((n) => n.type !== 'zone').map((n) => n.id))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nodes])
  const menuLinks = menu && active ? active.links.filter((l) => l.from === menu.nodeId || l.to === menu.nodeId) : []
  /** Other selected nodes, for "link to selected" when several are picked on the sheet. */
  const menuOthers = menu ? selected.filter((id) => id !== menu.nodeId && !active?.zones?.some((z) => z.id === id)) : []
  const edgeLink = edgeMenu ? active?.links.find((l) => l.id === edgeMenu.linkId) : undefined

  return (
    <div className="screen">
      <div className="screen__bar drag">
        <div className="tabstrip no-drag" role="tablist" aria-label="Листы карты">
          {tabs.map((m) =>
            renaming === m.id ? (
              <input
                key={m.id}
                className="tab-rename"
                autoFocus
                defaultValue={m.name}
                onBlur={(e) => (p.onSaveMaps(maps.map((x) => (x.id === m.id ? { ...x, name: e.target.value.trim() || x.name } : x))), setRenaming(null))}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <button key={m.id} role="tab" aria-selected={m.id === trail[0]?.id} className={`tab ${m.id === trail[0]?.id ? 'is-active' : ''}`} onClick={() => setActiveId(m.id)} onDoubleClick={() => setRenaming(m.id)}>
                <Icon name="map" size={14} />
                <span className="tab__title">{m.name}</span>
              </button>
            )
          )}
          <IconButton icon="plus" label="Новый лист" onClick={addSheet} />
        </div>
        <span className="screen__spacer" />
        <div className="no-drag toolbar">
          {active && (
            <span className="map-summary">
              <span className="ok">{sum.up} в сети</span>
              {sum.down > 0 && <span className="bad"> · {sum.down} недоступно</span>}
            </span>
          )}
          {selectedHosts.length > 1 && (
            <Button variant="tinted" icon="palette" onClick={() => p.onAppearance(selectedHosts)}>Значок и цвет</Button>
          )}
          {selectedHosts.length > 0 && (
            <Button variant="filled" icon="play" onClick={() => (selectedHosts.length === 1 ? p.onConnect(selectedHosts[0]) : p.onConnectMany(selectedHosts, `${active?.name ?? 'Карта'}: выбранные`))}>
              {selectedHosts.length === 1 ? 'Подключиться' : `Подключиться к ${selectedHosts.length}`}
            </Button>
          )}
          {active && <IconButton icon="select" label={boxMode ? 'Рамка выделения включена: тяните по листу, средняя кнопка двигает лист' : 'Рамка выделения (или тяните с Shift)'} active={boxMode} onClick={() => setBoxMode(!boxMode)} />}
          {active && (
            <MenuButton
              label="Добавить зону"
              icon="zone"
              items={ZONE_SHAPES.map((z) => ({ label: selected.some((id) => !active.zones?.some((x) => x.id === id)) ? `${z.label} вокруг выбранных` : `Зона: ${z.label.toLowerCase()}`, icon: z.icon, onSelect: () => addZone(z.value) }))}
            />
          )}
          {active && (
            <MenuButton
              label="Лист"
              items={[
                { label: 'Переименовать лист', icon: 'pencil', onSelect: () => setRenaming(active.id) },
                { label: 'Вложенный лист', icon: 'map', onSelect: addChildSheet },
                { label: 'Добавить зону', icon: 'zone', onSelect: () => addZone('rect') },
                { label: 'Добавить подпись', icon: 'textNode', onSelect: () => addNode({ label: 'Подпись', ...flow.screenToFlowPosition({ x: 400, y: 200 }) }) },
                { label: 'Удалить лист', icon: 'trash', destructive: true, onSelect: () => deleteSheet(active) }
              ]}
            />
          )}
        </div>
      </div>

      {!active ? (
        <EmptyState
          icon="map"
          title="Сетевая карта"
          message="Листы для зданий, этажей или сегментов. Перетащите хосты на лист, соедините их линиями с портами и следите за состоянием: красный значит недоступен."
          action={<Button variant="filled" icon="plus" onClick={addSheet}>Создать лист</Button>}
        />
      ) : (
        <div className="map-layout">
          {trail.length > 1 && (
            <nav className="map-trail" aria-label="Путь по листам">
              {trail.map((m, i) => (
                <span key={m.id}>
                  {i > 0 && <Icon name="chevronRight" size={12} />}
                  {i < trail.length - 1 ? (
                    <button onClick={() => setActiveId(m.id)}>{m.name}</button>
                  ) : renaming === m.id ? (
                    <input
                      className="tab-rename"
                      autoFocus
                      defaultValue={m.name}
                      onBlur={(e) => (p.onSaveMaps(maps.map((x) => (x.id === m.id ? { ...x, name: e.target.value.trim() || x.name } : x))), setRenaming(null))}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
                    />
                  ) : (
                    <b onDoubleClick={() => setRenaming(m.id)}>{m.name}</b>
                  )}
                </span>
              ))}
            </nav>
          )}
          <aside className="map-palette">
            <SearchField value={query} onChange={setQuery} placeholder="Найти хост" />
            <p className="muted">Перетащите на лист</p>
            <div className="map-palette__list">
              {palette.map((h) => (
                <div
                  key={h.id}
                  className={`map-palette__item ${onMap.has(h.id) ? 'is-placed' : ''}`}
                  draggable
                  onDragStart={(e) => (e.dataTransfer.setData(DRAG_TYPE, h.id), (e.dataTransfer.effectAllowed = 'copy'))}
                  title={h.folderId ? folderPath(store.folders, h.folderId) : undefined}
                >
                  <Tile tint={hostTint(store, h)} icon={hostIcon(store, h)} size="sm" />
                  <span>{h.name}</span>
                  {onMap.has(h.id) && <Icon name="check" size={13} />}
                </div>
              ))}
            </div>
          </aside>
          <div className={`map-canvas ${p.animations ? 'is-animated' : ''} ${boxMode ? 'is-box-select' : ''}`} onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy'))} onDrop={onDrop}>
            <ReactFlow<MapFlowNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={onDragStop}
              onSelectionDragStop={(e, dragged) => onDragStop(e, null, dragged)}
              onBeforeDelete={async ({ nodes: ns, edges: es }) => {
                // React Flow deletes a zone's children with it; the hosts in a room stay on the sheet.
                const chosen = new Set(nodes.filter((n) => n.selected).map((n) => n.id))
                const keep = ns.filter((n) => chosen.has(n.id))
                const kept = new Set(keep.map((n) => n.id))
                return { nodes: keep, edges: es.filter((e) => e.selected || kept.has(e.source) || kept.has(e.target)) }
              }}
              onSelectionChange={onSelectionChange}
              onConnect={(c) => c.source !== c.target && updateMap((m) => ({ ...m, links: [...m.links, { id: newId(), from: c.source, to: c.target }] }))}
              onEdgesChange={(changes) =>
                setSelectedEdges((cur) => {
                  const next = new Set(cur)
                  changes.forEach((c) => c.type === 'select' && (c.selected ? next.add(c.id) : next.delete(c.id)))
                  return next
                })
              }
              onEdgesDelete={(es) => {
                const gone = new Set(es.map((e) => e.id))
                updateMap((m) => ({ ...m, links: m.links.filter((l) => !gone.has(l.id)) }))
              }}
              onEdgeDoubleClick={(_e, edge) => setEditingLink(active.links.find((l) => l.id === edge.id) ?? null)}
              onNodeDoubleClick={(_e, n) => {
                const z = active.zones?.find((x) => x.id === n.id)
                if (z) return setEditingZone(z)
                const h = nodeHost(n.id)
                const sh = nodeSheet(n.id)
                if (h) p.onConnect(h)
                else if (sh) setActiveId(sh)
                else setLabelEdit({ nodeId: n.id, text: active.nodes.find((x) => x.id === n.id)?.label ?? '' })
              }}
              onNodeContextMenu={(e, n) => (e.preventDefault(), setEdgeMenu(null), setPaneMenu(null), setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id }))}
              onEdgeContextMenu={(e, edge) => (e.preventDefault(), setMenu(null), setPaneMenu(null), setEdgeMenu({ x: e.clientX, y: e.clientY, linkId: edge.id }))}
              onPaneContextMenu={(e) => (e.preventDefault(), setMenu(null), setEdgeMenu(null), setPaneMenu({ x: e.clientX, y: e.clientY }))}
              onPaneClick={() => (setMenu(null), setEdgeMenu(null), setPaneMenu(null))}
              selectionOnDrag={boxMode}
              panOnDrag={boxMode ? [1] : true}
              connectionMode={ConnectionMode.Loose}
              multiSelectionKeyCode={['Control', 'Meta']}
              selectionKeyCode="Shift"
              deleteKeyCode={['Delete', 'Backspace']}
              colorMode={matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
              proOptions={{ hideAttribution: true }}
              snapToGrid
              snapGrid={[10, 10]}
            >
              <Background variant={BackgroundVariant.Lines} gap={24} lineWidth={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeClassName={(n) => `minimap-node ${n.type === 'zone' ? 'is-zone' : n.type === 'host' ? `is-${health((n.data as { status?: HostStatus }).status)}` : ''}`} />
            </ReactFlow>
            <div className="map-hint muted">Правый клик: меню, связи, зоны · Двойной клик: подключиться или открыть · Ctrl + клик или Shift + рамка: несколько, тяните вместе · Delete: убрать</div>
            {menu && menuNode && menu.pick && (
              <ContextMenu x={menu.x} y={menu.y} className="map-context--picker" onClose={() => setMenu(null)}>
                <LinkPicker from={nodeTitle(menu.nodeId)} candidates={linkCandidates(menu.nodeId)} onCancel={() => setMenu(null)} onPick={(keys) => (setMenu(null), linkTo(menu.nodeId, keys))} />
              </ContextMenu>
            )}
            {menu && menuZone && (
              <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
                <MenuHeader>{menuZone.name}</MenuHeader>
                <MenuItem label="Изменить зону…" icon="pencil" onSelect={() => (setMenu(null), setEditingZone(menuZone))} />
                <div className="map-context__row">
                  <span>Форма</span>
                  <Segmented<ZoneShape> size="sm" value={menuZone.shape} onChange={(shape) => saveZone(withShape(menuZone, shape))} options={ZONE_SHAPES.map(({ value, label }) => ({ value, label: label === 'Прямоугольник' ? 'Прямоуг.' : label }))} />
                </div>
                <div className="map-context__row">
                  <TintPicker value={menuZone.tint} onChange={(tint) => saveZone({ ...menuZone, tint })} />
                </div>
                {zoneNodeIds(menuZone.id).length > 0 && (
                  <>
                    <MenuSeparator />
                    <MenuItem label={`Выделить всё в зоне (${zoneNodeIds(menuZone.id).length})`} icon="select" onSelect={() => (setMenu(null), selectOnly(zoneNodeIds(menuZone.id)))} />
                  </>
                )}
                {zoneHosts(menuZone.id).length > 0 && (
                  <>
                    <MenuItem label={`Подключиться ко всем (${zoneHosts(menuZone.id).length})`} icon="grid" onSelect={() => (setMenu(null), p.onConnectMany(zoneHosts(menuZone.id), menuZone.name))} />
                    <MenuItem label="Значок и цвет хостов…" icon="palette" onSelect={() => (setMenu(null), p.onAppearance(zoneHosts(menuZone.id)))} />
                  </>
                )}
                <MenuSeparator />
                <MenuItem label="Удалить зону" icon="trash" destructive onSelect={() => (setMenu(null), removeNodes([menuZone.id]))} />
              </ContextMenu>
            )}
            {paneMenu && (
              <ContextMenu x={paneMenu.x} y={paneMenu.y} onClose={() => setPaneMenu(null)}>
                <MenuHeader>Добавить зону</MenuHeader>
                {ZONE_SHAPES.map((z) => (
                  <MenuItem key={z.value} label={z.label} icon={z.icon} onSelect={() => (setPaneMenu(null), addZone(z.value, flow.screenToFlowPosition({ x: paneMenu.x, y: paneMenu.y })))} />
                ))}
                {selected.some((id) => !active.zones?.some((z) => z.id === id)) && (
                  <MenuItem label="Зона вокруг выбранных" icon="zone" onSelect={() => (setPaneMenu(null), addZone('rect'))} />
                )}
                <MenuSeparator />
                <MenuItem
                  label="Добавить подпись"
                  icon="textNode"
                  onSelect={() => {
                    const at = flow.screenToFlowPosition({ x: paneMenu.x, y: paneMenu.y })
                    setPaneMenu(null)
                    addNode({ label: 'Подпись', x: Math.round(at.x), y: Math.round(at.y) })
                  }}
                />
              </ContextMenu>
            )}
            {menu && menuNode && !menu.pick && (
              <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
                <MenuItem label="Добавить связь…" icon="link" onSelect={() => setMenu({ ...menu, pick: true })} />
                {menuOthers.length > 0 && (
                  <MenuItem label={`Связать с выбранными (${menuOthers.length})`} icon="link" onSelect={() => (setMenu(null), linkTo(menu.nodeId, menuOthers.map((id) => `node:${id}`)))} />
                )}
                {menuLinks.length > 0 && (
                  <>
                    <MenuSeparator />
                    <MenuHeader>Связи</MenuHeader>
                    {menuLinks.slice(0, 8).map((l) => {
                      const other = l.from === menu.nodeId ? l.to : l.from
                      const port = l.from === menu.nodeId ? l.fromIf : l.toIf
                      return <MenuItem key={l.id} label={`${port ? `${port} → ` : ''}${nodeTitle(other)}`} icon="pencil" onSelect={() => (setMenu(null), setEditingLink(l))} />
                    })}
                    {menuLinks.length > 8 && <MenuHeader>и ещё {menuLinks.length - 8}: правый клик по линии</MenuHeader>}
                  </>
                )}
                <MenuSeparator />
                {menuHost && (
                  <>
                    <MenuItem label="Подключиться" icon="terminal" onSelect={() => (setMenu(null), p.onConnect(menuHost))} />
                    {selectedHosts.length > 1 && (
                      <MenuItem label={`Подключиться к выбранным (${selectedHosts.length})`} icon="grid" onSelect={() => (setMenu(null), p.onConnectMany(selectedHosts, `${active?.name ?? 'Карта'}: выбранные`))} />
                    )}
                    <MenuItem label="Открыть в браузере" icon="globe" onSelect={() => (setMenu(null), p.onBrowser(menuHost))} />
                    {hostsById.get(menuHost) && effectiveSettings(store.folders, hostsById.get(menuHost)!).winbox && (
                      <MenuItem label="Открыть в WinBox" icon="winbox" onSelect={() => (setMenu(null), p.onWinbox(menuHost))} />
                    )}
                    {p.onTools && <MenuItem label="Сетевые инструменты" icon="wrench" onSelect={() => (setMenu(null), p.onTools!(menuHost))} />}
                    <MenuItem label="Изменить хост" icon="pencil" onSelect={() => (setMenu(null), p.onEditHost(menuHost))} />
                    <MenuItem
                      label={selectedHosts.length > 1 && selectedHosts.includes(menuHost) ? `Значок и цвет (${selectedHosts.length})…` : 'Значок и цвет…'}
                      icon="palette"
                      onSelect={() => (setMenu(null), p.onAppearance(selectedHosts.length > 1 && selectedHosts.includes(menuHost) ? selectedHosts : [menuHost]))}
                    />
                  </>
                )}
                {menuSheet && <MenuItem label="Открыть лист" icon="map" onSelect={() => (setMenu(null), setActiveId(menuSheet))} />}
                {menuSheet && sheetHosts(menuSheet).length > 0 && (
                  <MenuItem label={`Подключиться ко всем (${sheetHosts(menuSheet).length})`} icon="grid" onSelect={() => (setMenu(null), p.onConnectMany(sheetHosts(menuSheet), maps.find((m) => m.id === menuSheet)?.name))} />
                )}
                {!menuHost && !menuSheet && (
                  <MenuItem label="Изменить подпись" icon="pencil" onSelect={() => (setMenu(null), setLabelEdit({ nodeId: menuNode.id, text: menuNode.label ?? '' }))} />
                )}
                <MenuSeparator />
                {menuNode.zoneId && (
                  <MenuItem label="Вынуть из зоны" icon="zone" onSelect={() => (setMenu(null), updateMap((m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === menuNode.id ? { ...n, zoneId: undefined } : n)) })))} />
                )}
                <MenuItem label="Убрать с листа" icon="trash" destructive onSelect={() => (setMenu(null), removeNodes([menu.nodeId]))} />
              </ContextMenu>
            )}
            {edgeMenu && edgeLink && (
              <ContextMenu x={edgeMenu.x} y={edgeMenu.y} onClose={() => setEdgeMenu(null)}>
                <MenuHeader>
                  {nodeTitle(edgeLink.from)} ↔ {nodeTitle(edgeLink.to)}
                </MenuHeader>
                <MenuItem label="Изменить связь…" icon="pencil" onSelect={() => (setEdgeMenu(null), setEditingLink(edgeLink))} />
                <div className="map-context__row">
                  <span>Форма</span>
                  <Segmented<LinkShape>
                    size="sm"
                    value={edgeLink.shape ?? 'curve'}
                    onChange={(shape) => updateLink(edgeLink.id, { shape })}
                    options={[{ value: 'curve', label: 'Дуга' }, { value: 'straight', label: 'Прямая' }, { value: 'step', label: 'Ступенька' }]}
                  />
                </div>
                {edgeLink.bend && <MenuItem label="Выпрямить" icon="chevronRight" onSelect={() => (setEdgeMenu(null), updateLink(edgeLink.id, { bend: undefined }))} />}
                <MenuSeparator />
                <MenuItem label="Удалить связь" icon="trash" destructive onSelect={() => (setEdgeMenu(null), deleteLink(edgeLink.id))} />
              </ContextMenu>
            )}
          </div>
        </div>
      )}

      {labelEdit && active && (
        <Sheet
          title="Подпись"
          onCancel={() => setLabelEdit(null)}
          onDone={() => (updateMap((m) => ({ ...m, nodes: m.nodes.map((x) => (x.id === labelEdit.nodeId ? { ...x, label: labelEdit.text } : x)) })), setLabelEdit(null))}
        >
          <Group footer="Например: провайдер, облако, «Корпус Б», «DMZ».">
            <Row label="Текст">
              <Field autoFocus value={labelEdit.text} onChange={(e) => setLabelEdit({ ...labelEdit, text: e.target.value })} />
            </Row>
          </Group>
        </Sheet>
      )}

      {editingZone && active && (
        <ZoneSheet
          key={editingZone.id}
          zone={editingZone}
          hosts={zoneNodeIds(editingZone.id).length}
          onCancel={() => setEditingZone(null)}
          onSave={(z) => (saveZone(z), setEditingZone(null))}
          onDelete={() => (removeNodes([editingZone.id]), setEditingZone(null))}
        />
      )}

      {editingLink && active && (
        <LinkSheet
          link={editingLink}
          fromName={nameOf(active, editingLink.from, hostsById)}
          toName={nameOf(active, editingLink.to, hostsById)}
          onCancel={() => setEditingLink(null)}
          onSave={(l) => (updateMap((m) => ({ ...m, links: m.links.map((x) => (x.id === l.id ? l : x)) })), setEditingLink(null))}
          onDelete={() => (updateMap((m) => ({ ...m, links: m.links.filter((x) => x.id !== editingLink.id) })), setEditingLink(null))}
        />
      )}
    </div>
  )
}

function nameOf(m: NetMap, nodeId: string, hosts: Map<string, { name: string }>): string {
  const n = m.nodes.find((x) => x.id === nodeId)
  return (n?.hostId && hosts.get(n.hostId)?.name) || n?.label || 'узел'
}

const shallowEqual = (a: object, b: object) => {
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
}

/** Whether a rebuilt node shows and sits exactly like the one already on the sheet. */
function sameNode(a: MapFlowNode, b: MapFlowNode): boolean {
  return (
    a.type === b.type &&
    a.parentId === b.parentId &&
    !!a.selected === !!b.selected &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.dragHandle === b.dragHandle &&
    shallowEqual(a.data, b.data)
  )
}
