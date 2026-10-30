import { useCallback, useState, type DragEvent } from 'react'
import type { Provider } from '../../services/api'
import {
  PROVIDER_MOVE_DOWN,
  PROVIDER_MOVE_UP,
  PROVIDER_STATUS_SUFFIX_NOT_IN_USE,
  PROVIDER_STATUS_SUFFIX_UNAVAILABLE,
  TASK_FALLBACK_LABEL,
} from '../../constants/strings'
import { Button } from '../ui/Button'

interface TaskFallbackOrderProps {
  providers: Provider[]
  order: string[]
  onReorder: (order: string[]) => void
}

function reorderBySwappingNeighbors(currentOrder: string[], index: number, direction: 'up' | 'down'): string[] {
  const neighborIndex = direction === 'up' ? index - 1 : index + 1
  if (neighborIndex < 0 || neighborIndex >= currentOrder.length) return currentOrder
  const nextOrder = [...currentOrder]
  const temporary = nextOrder[index]
  nextOrder[index] = nextOrder[neighborIndex]
  nextOrder[neighborIndex] = temporary
  return nextOrder
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return items
  const next = [...items]
  const [removed] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, removed)
  return next
}

export function TaskFallbackOrder({ providers, order, onReorder }: TaskFallbackOrderProps) {
  const providerMap = Object.fromEntries(providers.map((provider) => [provider.id, provider]))
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

  const handleDragStart = useCallback(
    (index: number) => (event: DragEvent) => {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(index))
      setDragIndex(index)
    },
    [],
  )

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setDropTargetIndex(null)
  }, [])

  const handleDragOver = useCallback(
    (index: number) => (event: DragEvent) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTargetIndex(index)
    },
    [],
  )

  const handleDrop = useCallback(
    (toIndex: number) => (event: DragEvent) => {
      event.preventDefault()
      const fromData = event.dataTransfer.getData('text/plain')
      const fromParsed = parseInt(fromData, 10)
      const fromIndex = Number.isFinite(fromParsed) ? fromParsed : (dragIndex ?? -1)
      if (fromIndex < 0 || fromIndex >= order.length) {
        setDragIndex(null)
        setDropTargetIndex(null)
        return
      }
      if (fromIndex !== toIndex) onReorder(moveItem(order, fromIndex, toIndex))
      setDragIndex(null)
      setDropTargetIndex(null)
    },
    [dragIndex, onReorder, order],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-sm font-medium text-text-secondary">{TASK_FALLBACK_LABEL}</div>
      <ol className="space-y-1" aria-label={TASK_FALLBACK_LABEL}>
        {order.map((providerId, index) => {
          const provider = providerMap[providerId]
          const isFirst = index === 0
          const isLast = index === order.length - 1
          const isDragging = dragIndex === index
          const isDropTarget = dropTargetIndex === index && dragIndex !== null && dragIndex !== index

          return (
            <li
              key={providerId}
              draggable
              onDragStart={handleDragStart(index)}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver(index)}
              onDrop={handleDrop(index)}
              className={`
                flex items-center gap-2 text-sm rounded-base border border-transparent px-1 -mx-1 py-0.5
                ${isDragging ? 'opacity-60' : ''}
                ${isDropTarget ? 'border-accent bg-accent-light/30' : ''}
              `.trim()}
            >
              <span
                className="cursor-grab active:cursor-grabbing text-text-tertiary select-none touch-none px-0.5"
                aria-hidden
              >
                ⋮⋮
              </span>
              <span className="w-5 h-5 rounded-full bg-accent-light text-accent flex items-center justify-center text-xs font-bold shrink-0">
                {index + 1}
              </span>
              <span className="font-medium text-text flex-1 min-w-0 truncate">{provider?.name ?? providerId}</span>
              {provider && !provider.enabled && (
                <span className="text-xs text-text-tertiary shrink-0">{PROVIDER_STATUS_SUFFIX_NOT_IN_USE}</span>
              )}
              {provider && provider.enabled && !provider.available && (
                <span className="text-xs text-text-tertiary shrink-0">{PROVIDER_STATUS_SUFFIX_UNAVAILABLE}</span>
              )}
              <span className="flex items-center gap-0.5 shrink-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isFirst}
                  aria-label={PROVIDER_MOVE_UP}
                  className="!px-1.5 !py-0.5 min-w-0"
                  onClick={() => onReorder(reorderBySwappingNeighbors(order, index, 'up'))}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isLast}
                  aria-label={PROVIDER_MOVE_DOWN}
                  className="!px-1.5 !py-0.5 min-w-0"
                  onClick={() => onReorder(reorderBySwappingNeighbors(order, index, 'down'))}
                >
                  ↓
                </Button>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
