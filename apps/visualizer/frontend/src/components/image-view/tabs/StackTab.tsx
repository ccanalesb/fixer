import { useEffect, useState, type ReactNode } from 'react'
import type { CatalogImage } from '../../../services/api'
import { ImagesAPI } from '../../../services/api'
import { Button } from '../../ui/Button/Button'
import { ConfirmModalFrame, UndoToastBar, useUndoToast } from '../../ui/ConfirmUndoAction'
import {
  ACTION_CANCEL,
  ACTION_UNDO,
  CATALOG_STACK_CONFIRM_MERGE_BODY,
  CATALOG_STACK_CONFIRM_MERGE_TITLE,
  CATALOG_STACK_CONFIRM_REP_BODY,
  CATALOG_STACK_CONFIRM_REP_TITLE,
  CATALOG_STACK_CONFIRM_SPLIT_BODY,
  CATALOG_STACK_CONFIRM_SPLIT_TITLE,
  CATALOG_STACK_MAKE_REPRESENTATIVE,
  CATALOG_STACK_MERGE_INTO,
  CATALOG_STACK_MERGE_PLACEHOLDER,
  CATALOG_STACK_MERGE_RUN,
  CATALOG_STACK_MERGE_SOURCE_ARIA,
  CATALOG_STACK_SPLIT_OUT,
  CATALOG_STACK_TOAST_REP_UPDATED,
  IMAGE_DETAILS_STACK_MEMBER_ARIA,
  IMAGE_DETAILS_STACK_REPRESENTATIVE,
  IMAGE_DETAILS_STACK_SELECTED,
  IMAGE_DETAILS_TAB_STACK,
} from '../../../constants/strings'
import { ActionArea, ActionRow, ToolBlock } from '../detail-blocks'

type ConfirmSpec = {
  title: ReactNode
  body: string
  confirmLabel: string
  confirmVariant: 'danger' | 'primary'
  onConfirm: () => Promise<void>
}

/** The burst stack the photo belongs to: split, re-pick its representative, merge another in. */
export function StackTab({
  stackId,
  imageKey,
  onDataChanged,
}: {
  stackId: number
  imageKey: string
  onDataChanged: () => void
}) {
  const [members, setMembers] = useState<CatalogImage[] | null>(null)
  const [selectedKey, setSelectedKey] = useState(imageKey)
  const [mutating, setMutating] = useState(false)
  const [mergeSourceId, setMergeSourceId] = useState('')
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const { toast, offerUndo, runUndo } = useUndoToast()

  useEffect(() => setSelectedKey(imageKey), [imageKey])

  useEffect(() => {
    let cancelled = false
    void ImagesAPI.getStackMembers(stackId)
      .then((r) => !cancelled && setMembers(r.items))
      .catch(() => !cancelled && setMembers([]))
    return () => {
      cancelled = true
    }
  }, [stackId])

  async function refreshMembers() {
    try {
      setMembers((await ImagesAPI.getStackMembers(stackId)).items)
    } catch {
      setMembers([])
    }
    onDataChanged()
  }

  async function runConfirmed(spec: ConfirmSpec) {
    setMutating(true)
    try {
      await spec.onConfirm()
    } finally {
      setMutating(false)
      setConfirm(null)
    }
  }

  if (!members || members.length < 2) return null

  const selected = members.find((m) => m.key === selectedKey) ?? null
  const rep = members.find((m) => m.is_stack_representative)?.key ?? null

  const confirmSplit = (memberKey: string) =>
    setConfirm({
      title: CATALOG_STACK_CONFIRM_SPLIT_TITLE,
      body: CATALOG_STACK_CONFIRM_SPLIT_BODY,
      confirmLabel: CATALOG_STACK_SPLIT_OUT,
      confirmVariant: 'danger',
      onConfirm: async () => {
        await ImagesAPI.splitStackMember(stackId, memberKey)
        await refreshMembers()
      },
    })

  const confirmRep = (memberKey: string) => {
    if (!rep || rep === memberKey) return
    setConfirm({
      title: CATALOG_STACK_CONFIRM_REP_TITLE,
      body: CATALOG_STACK_CONFIRM_REP_BODY,
      confirmLabel: CATALOG_STACK_MAKE_REPRESENTATIVE,
      confirmVariant: 'primary',
      onConfirm: async () => {
        await ImagesAPI.setStackRepresentative(stackId, memberKey)
        await refreshMembers()
        offerUndo(CATALOG_STACK_TOAST_REP_UPDATED, async () => {
          await ImagesAPI.setStackRepresentative(stackId, rep)
          await refreshMembers()
        })
      },
    })
  }

  const confirmMerge = () => {
    const sid = parseInt(mergeSourceId.trim(), 10)
    if (!Number.isFinite(sid) || sid < 1 || sid === stackId) return
    setConfirm({
      title: CATALOG_STACK_CONFIRM_MERGE_TITLE,
      body: CATALOG_STACK_CONFIRM_MERGE_BODY,
      confirmLabel: CATALOG_STACK_MERGE_RUN,
      confirmVariant: 'danger',
      onConfirm: async () => {
        await ImagesAPI.mergeStacks(stackId, sid)
        setMergeSourceId('')
        onDataChanged()
      },
    })
  }

  return (
    <>
      <ToolBlock title={IMAGE_DETAILS_TAB_STACK(members.length)}>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {members.map((m) => {
            const name = m.filename ?? m.key
            const isSelected = m.key === selectedKey
            return (
              <div key={m.key} className="w-20 shrink-0">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={IMAGE_DETAILS_STACK_MEMBER_ARIA(name)}
                  onClick={() => setSelectedKey(m.key)}
                  className={`block aspect-square w-full overflow-hidden rounded-base bg-surface ${
                    isSelected ? 'ring-2 ring-accent ring-offset-1' : 'opacity-80 hover:opacity-100'
                  }`}
                >
                  <img
                    src={`/api/images/catalog/${encodeURIComponent(m.key)}/thumbnail`}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
                <p className="mt-1 truncate text-[11px] text-text-tertiary">
                  {m.is_stack_representative ? IMAGE_DETAILS_STACK_REPRESENTATIVE : name}
                </p>
              </div>
            )
          })}
        </div>
      </ToolBlock>

      <ActionArea>
        {selected ? (
          <ActionRow label={IMAGE_DETAILS_STACK_SELECTED(selected.filename ?? selected.key)}>
            {rep && !selected.is_stack_representative ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={mutating}
                onClick={() => confirmRep(selected.key)}
              >
                {CATALOG_STACK_MAKE_REPRESENTATIVE}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={mutating}
              onClick={() => confirmSplit(selected.key)}
            >
              {CATALOG_STACK_SPLIT_OUT}
            </Button>
          </ActionRow>
        ) : null}
        {rep ? (
          <ActionRow label={CATALOG_STACK_MERGE_INTO}>
            <input
              type="text"
              inputMode="numeric"
              aria-label={CATALOG_STACK_MERGE_SOURCE_ARIA}
              placeholder={CATALOG_STACK_MERGE_PLACEHOLDER}
              value={mergeSourceId}
              disabled={mutating}
              onChange={(e) => setMergeSourceId(e.target.value)}
              className="h-8 w-24 rounded-base border border-border bg-bg px-2 text-sm text-text"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={mutating || !mergeSourceId.trim()}
              onClick={confirmMerge}
            >
              {CATALOG_STACK_MERGE_RUN}
            </Button>
          </ActionRow>
        ) : null}
      </ActionArea>

      {confirm ? (
        <ConfirmModalFrame
          zIndexClass="z-[80]"
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={ACTION_CANCEL}
          confirmVariant={confirm.confirmVariant}
          onConfirm={() => void runConfirmed(confirm)}
          onCancel={() => setConfirm(null)}
          busy={mutating}
        >
          <p className="text-sm text-text-secondary">{confirm.body}</p>
        </ConfirmModalFrame>
      ) : null}

      <UndoToastBar toast={toast} undoLabel={ACTION_UNDO} onUndo={() => void runUndo()} />
    </>
  )
}
