import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Job } from '../../../types/job'
import { DescriptionsAPI, JobsAPI, PerspectivesAPI, ProvidersAPI, ScoresAPI } from '../../../services/api'
import { useJobSocket } from '../../../hooks/useJobSocket'
import { invalidate, useQuery } from '../../../data'
import { DescriptionPanel } from '../../DescriptionPanel'
import ImageScoresPanel from '../../catalog/ImageScoresPanel'
import { Button } from '../../ui/Button/Button'
import { ProviderModelSelect } from '../../ui/ProviderModelSelect'
import {
  ACTION_SCORING_IN_PROGRESS,
  IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL,
  IMAGE_DETAILS_GENERATE_DESCRIPTION,
  IMAGE_DETAILS_GENERATE_SCORES,
  IMAGE_DETAILS_GENERATING_DESCRIPTION,
  IMAGE_DETAILS_MODEL,
  IMAGE_DETAILS_MODEL_DEFAULT,
  IMAGE_DETAILS_PERSPECTIVE_ANALYSIS,
} from '../../../constants/strings'
import { ActionArea, ActionRow, GeneratedBlock } from '../detail-blocks'

type Run = { jobId: string | null; busy: boolean; error: string | null }
const IDLE: Run = { jobId: null, busy: false, error: null }

/** The photo's description and perspective scores, and the jobs that rewrite them. */
export function AiTab({ imageKey, onDataChanged }: { imageKey: string; onDataChanged?: () => void }) {
  const defaults = useQuery(['providers.defaults'] as const, () => ProvidersAPI.getDefaults())
  const perspectives = useQuery(['perspectives', 'list', 'active'] as const, () =>
    PerspectivesAPI.list({ active_only: true }),
  )
  const description = useQuery(['descriptions', imageKey] as const, () => DescriptionsAPI.get(imageKey))
    .description
  const [scoresToken, setScoresToken] = useState(0)
  const scores = useQuery(['scores', 'current', imageKey, 'catalog', scoresToken] as const, () =>
    ScoresAPI.getCurrent(imageKey, { image_type: 'catalog' }),
  )

  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [showModels, setShowModels] = useState(false)
  const [describeRun, setDescribeRun] = useState<Run>(IDLE)
  const [scoreRun, setScoreRun] = useState<Run>(IDLE)

  useEffect(() => {
    const d = defaults.description
    if (d?.provider) setProviderId((p) => p ?? d.provider)
    if (d?.model) setModelId((m) => m ?? d.model ?? null)
  }, [defaults])

  const perspectiveLabels = useMemo(
    () => Object.fromEntries(perspectives.map((p) => [p.slug, p.display_name])),
    [perspectives],
  )

  useJobSocket({
    onJobUpdated: useCallback(
      (job: Job) => {
        const settle = (
          run: Run,
          set: (r: Run) => void,
          onDone: () => void,
          failure: string,
        ) => {
          if (!run.jobId || job.id !== run.jobId) return
          if (job.status === 'completed') {
            set(IDLE)
            onDone()
            onDataChanged?.()
          } else if (job.status === 'failed') {
            set({ ...IDLE, error: job.error ?? failure })
          } else if (job.status === 'cancelled') {
            set(IDLE)
          }
        }
        settle(describeRun, setDescribeRun, () => invalidate(['descriptions', imageKey]), 'Description generation failed')
        settle(scoreRun, setScoreRun, () => setScoresToken((n) => n + 1), 'Scoring failed')
      },
      [describeRun, scoreRun, imageKey, onDataChanged],
    ),
  })

  const start = async (type: 'single_describe' | 'single_score', set: (r: Run) => void) => {
    set({ ...IDLE, busy: true })
    try {
      const job = await JobsAPI.create(type, {
        image_key: imageKey,
        image_type: 'catalog',
        force: type === 'single_score',
        ...(providerId && { provider_id: providerId }),
        ...(modelId && { provider_model: modelId }),
      })
      set({ jobId: job.id, busy: true, error: null })
    } catch (err) {
      set({ ...IDLE, error: String(err) })
    }
  }

  const hasDescription = Boolean(description?.summary)
  const hasScores = (scores.current?.length ?? 0) > 0

  return (
    <>
      <GeneratedBlock
        title={IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL}
        busy={describeRun.busy ? IMAGE_DETAILS_GENERATING_DESCRIPTION : null}
        error={describeRun.error}
      >
        <DescriptionPanel description={description} />
      </GeneratedBlock>
      <GeneratedBlock
        title={IMAGE_DETAILS_PERSPECTIVE_ANALYSIS}
        busy={scoreRun.busy ? ACTION_SCORING_IN_PROGRESS : null}
        error={scoreRun.error}
      >
        <ImageScoresPanel
          imageKey={imageKey}
          imageType="catalog"
          reloadToken={scoresToken}
          perspectiveLabels={perspectiveLabels}
        />
      </GeneratedBlock>

      <ActionArea>
        <ActionRow label={IMAGE_DETAILS_MODEL}>
          <button
            type="button"
            aria-expanded={showModels}
            onClick={() => setShowModels((v) => !v)}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            {modelId ?? IMAGE_DETAILS_MODEL_DEFAULT} ▾
          </button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={describeRun.busy}
            onClick={() => void start('single_describe', setDescribeRun)}
          >
            {IMAGE_DETAILS_GENERATE_DESCRIPTION(hasDescription)}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={scoreRun.busy}
            onClick={() => void start('single_score', setScoreRun)}
          >
            {IMAGE_DETAILS_GENERATE_SCORES(hasScores)}
          </Button>
        </ActionRow>
        {showModels ? (
          <ProviderModelSelect
            providerId={providerId}
            modelId={modelId}
            onChange={(pid, mid) => {
              setProviderId(pid)
              setModelId(mid)
            }}
          />
        ) : null}
      </ActionArea>
    </>
  )
}
