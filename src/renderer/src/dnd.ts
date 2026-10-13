import type { DragEvent } from 'react'

/**
 * Dragging hosts and folders onto a folder (card, sidebar tree, breadcrumbs) moves them there.
 * The payload is a list of keys: "h:<id>" for hosts, "f:<id>" for folders.
 */
const TYPE = 'application/x-pult-items'

export type MoveItems = (hostIds: string[], folderIds: string[], target: string | null) => void

export function startDrag(e: DragEvent, keys: string[]): void {
  e.dataTransfer.setData(TYPE, JSON.stringify(keys))
  e.dataTransfer.effectAllowed = 'move'
}

const carries = (e: DragEvent) => e.dataTransfer.types.includes(TYPE)

/**
 * Handlers for one drop target. `setOver` highlights the target the pointer is over;
 * `target` is a folder id, or null for the top level.
 */
export function dropTarget(target: string | null, onMove: MoveItems, setOver: (t: string | null | undefined) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (!carries(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver(target)
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setOver(undefined)
    },
    onDrop: (e: DragEvent) => {
      if (!carries(e)) return
      e.preventDefault()
      e.stopPropagation()
      setOver(undefined)
      let keys: string[] = []
      try {
        keys = JSON.parse(e.dataTransfer.getData(TYPE))
      } catch {
        return
      }
      const hosts = keys.filter((k) => k.startsWith('h:')).map((k) => k.slice(2))
      const folders = keys.filter((k) => k.startsWith('f:')).map((k) => k.slice(2)).filter((id) => id !== target)
      if (hosts.length || folders.length) onMove(hosts, folders, target)
    }
  }
}
