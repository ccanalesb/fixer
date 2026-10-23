import { useCallback, useState, type ReactNode } from 'react'
import { CullingModelsAPI, CullingProfilesAPI, type CullingModelsUsable, type CullingStageKind } from '../../services/api'
import { CullingStageDialog } from './CullingStageDialog'
import { firstUnusable, withStageOff, type CullingGateVerb } from './stageUsability'

interface Pending {
  stage: CullingStageKind
  usable: CullingModelsUsable
  verb: CullingGateVerb
  start: () => Promise<void>
}

const turnStageOff = (stage: CullingStageKind) =>
  stage === 'culling_profile'
    ? CullingProfilesAPI.saveCullingProfileSwitches({ enabled: false })
    : CullingProfilesAPI.saveScoreForecast({ enabled: false })

/**
 * Nothing that runs culling first starts while a stage that is on cannot run: `run` asks the backend,
 * and opens the dialog for the culling profile, then the Score forecast, before calling `start`.
 * `start` handles its own errors; `run` rejects only when the backend cannot be asked.
 */
export function useCullingGate(opts: { onStageOff?: () => void } = {}): {
  run: (verb: CullingGateVerb, start: () => Promise<void>) => Promise<void>
  checking: boolean
  dialog: ReactNode
} {
  const { onStageOff } = opts
  const [checking, setChecking] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const proceed = useCallback(async (usable: CullingModelsUsable, verb: CullingGateVerb, start: () => Promise<void>) => {
    const stage = firstUnusable(usable)
    setError(null)
    if (stage) {
      setPending({ stage, usable, verb, start })
      return
    }
    setPending(null)
    await start()
  }, [])

  const run = useCallback(
    async (verb: CullingGateVerb, start: () => Promise<void>) => {
      setChecking(true)
      let usable: CullingModelsUsable
      try {
        usable = await CullingModelsAPI.usable()
      } finally {
        setChecking(false)
      }
      await proceed(usable, verb, start)
    },
    [proceed],
  )

  const turnOff = async () => {
    if (!pending || busy) return
    setBusy(true)
    try {
      await turnStageOff(pending.stage)
      onStageOff?.()
      await proceed(withStageOff(pending.usable, pending.stage), pending.verb, pending.start)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const dialog = pending ? (
    <CullingStageDialog
      stage={pending.stage}
      usable={pending.usable}
      verb={pending.verb}
      busy={busy}
      error={error}
      onCancel={() => setPending(null)}
      onTurnOff={() => void turnOff()}
    />
  ) : null

  return { run, checking, dialog }
}
