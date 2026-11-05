import { useCallback, useRef, useState, type ReactNode } from 'react'
import {
  CullingModelsAPI,
  ProvidersAPI,
  type CullingModelsUsable,
  type CullingStageKind,
} from '../../services/api'
import { turnStageOff } from './pipelineStageSwitch'
import { CullingStageDialog } from './CullingStageDialog'
import { firstUnusable, withStageOff, type CullingGateVerb } from './stageUsability'

export type CullingGateResult<T> =
  | { status: 'started'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown }

interface Pending<T> {
  stage: CullingStageKind
  usable: CullingModelsUsable
  verb: CullingGateVerb
  enqueue: () => Promise<T>
  settle: (result: CullingGateResult<T>) => void
}

/**
 * Nothing that runs culling first starts while a stage that is on cannot run: `run` asks the backend,
 * and opens the dialog for the culling profile, then the Score forecast, before calling `enqueue`.
 * `run` always settles; callers read `started`, `cancelled`, or `failed`.
 */
export function useCullingGate(opts: { onStageOff?: () => void } = {}): {
  run: <T>(verb: CullingGateVerb, enqueue: () => Promise<T>) => Promise<CullingGateResult<T>>
  checking: boolean
  dialog: ReactNode
} {
  const { onStageOff } = opts
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState<Pending<unknown> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pendingRef = useRef<Pending<unknown> | null>(null)
  const runSettledRef = useRef(false)

  const clearPending = useCallback(() => {
    pendingRef.current = null
    setPending(null)
  }, [])

  const runEnqueue = useCallback(
    async <T,>(enqueue: () => Promise<T>, settle: (result: CullingGateResult<T>) => void) => {
      try {
        const value = await enqueue()
        clearPending()
        settle({ status: 'started', value })
      } catch (e) {
        clearPending()
        settle({ status: 'failed', error: e })
      }
    },
    [clearPending],
  )

  const proceed = useCallback(
    async <T,>(
      usable: CullingModelsUsable,
      verb: CullingGateVerb,
      enqueue: () => Promise<T>,
      settle: (result: CullingGateResult<T>) => void,
    ) => {
      const stage = firstUnusable(usable)
      setError(null)
      if (stage) {
        const next: Pending<T> = { stage, usable, verb, enqueue, settle }
        pendingRef.current = next as Pending<unknown>
        setPending(next as Pending<unknown>)
        return
      }
      clearPending()
      await runEnqueue(enqueue, settle)
    },
    [clearPending, runEnqueue],
  )

  const run = useCallback(
    async <T,>(verb: CullingGateVerb, enqueue: () => Promise<T>): Promise<CullingGateResult<T>> => {
      return new Promise((settle) => {
        runSettledRef.current = false
        const finish = (result: CullingGateResult<T>) => {
          if (runSettledRef.current) return
          runSettledRef.current = true
          settle(result)
        }
        void (async () => {
          setChecking(true)
          try {
            const usable = await CullingModelsAPI.usable()
            setChecking(false)
            await proceed(usable, verb, enqueue, finish)
          } catch (e) {
            setChecking(false)
            finish({ status: 'failed', error: e })
          }
        })()
      })
    },
    [proceed],
  )

  const failInDialog = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    setError(msg)
    pendingRef.current?.settle({ status: 'failed', error: e })
  }

  const turnOff = async () => {
    const p = pendingRef.current
    if (!p || busy) return
    setBusy(true)
    try {
      await turnStageOff(p.stage)
      onStageOff?.()
      setError(null)
      await proceed(withStageOff(p.usable, p.stage), p.verb, p.enqueue, p.settle)
    } catch (e) {
      failInDialog(e)
    } finally {
      setBusy(false)
    }
  }

  const turnProviderBackOn = async () => {
    const p = pendingRef.current
    if (!p || busy) return
    const s = p.usable[p.stage]
    if (s.problem !== 'parked' || s.endpoint === 'this_app') return
    setBusy(true)
    try {
      await ProvidersAPI.update(s.endpoint, { enabled: true })
      const usable = await CullingModelsAPI.usable()
      setError(null)
      await proceed(usable, p.verb, p.enqueue, p.settle)
    } catch (e) {
      failInDialog(e)
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    if (!runSettledRef.current) {
      pendingRef.current?.settle({ status: 'cancelled' })
      runSettledRef.current = true
    }
    clearPending()
    setError(null)
  }

  const dialog = pending ? (
    <CullingStageDialog
      stage={pending.stage}
      usable={pending.usable}
      verb={pending.verb}
      busy={busy}
      error={error}
      onCancel={cancel}
      onTurnOff={() => void turnOff()}
      onTurnProviderBackOn={() => void turnProviderBackOn()}
    />
  ) : null

  return { run, checking, dialog }
}
