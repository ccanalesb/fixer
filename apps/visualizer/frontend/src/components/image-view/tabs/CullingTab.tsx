import { useCallback, useState } from 'react'
import { CullAPI, FrameSubstanceAPI, type CullReviewDetail, type FrameSubstanceResponse } from '../../../services/api'
import { useQuery } from '../../../data'
import { keys } from '../../../data/keys'
import { Button } from '../../ui/Button'
import { levelHighlightClass } from '../../cull/cullHighlight'
import { rowSendButtonLabel } from '../../cull/sendLabel'
import { useCullingGate } from '../../cull/useCullingGate'
import {
  CULL_AGREE,
  CULL_AGREED,
  CULL_FILTERED_BY,
  CULL_PASS_HINT,
  CULL_PASS_NO,
  CULL_PASS_QUESTION,
  CULL_PASS_YES,
  CULL_SCORE_FORECAST,
  CULL_SENT_BY_HAND,
  CULL_SENT_BY_HAND_NOTE,
  CULL_VERDICT_FILTERED,
  CULL_VERDICT_PASSED,
  FRAME_SUBSTANCE_ADVISORY_LABEL,
  FRAME_SUBSTANCE_LABEL,
  FRAME_SUBSTANCE_OVERRIDE_RESCORE_WARN,
  FRAME_SUBSTANCE_OVERRIDE_RESTORE,
  FRAME_SUBSTANCE_RESTORED,
  FRAME_SUBSTANCE_STALE,
  IMAGE_DETAILS_PROFILE_READINGS,
  SCORE_FORECAST_DOES_NOT_APPLY,
} from '../../../constants/strings'
import { ActionArea, ActionRow, BlockHeading, StatusBlock } from '../detail-blocks'
import { frameHeldBack, frameSaysNothing, frameSubstanceQuery, frameVerdictSummary } from './frameSubstance'

const SELECTED_ANSWER_CLASS = '!border-accent !text-accent !bg-accent-light'

function ProfileReadings({ profile }: { profile: CullReviewDetail['profile'] }) {
  if (profile.level_sets.length === 0) return null
  return (
    <section>
      <BlockHeading>{IMAGE_DETAILS_PROFILE_READINGS}</BlockHeading>
      {profile.name ? <p className="mb-1 text-sm font-medium text-text">{profile.name}</p> : null}
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left" />
            {profile.level_sets.map((s) => (
              <th key={s.id} className="p-1 text-right font-medium text-text-tertiary">
                {s.id} levels
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profile.level_sets[0]?.dimensions.map((dim) => (
            <tr key={dim.slug}>
              <td className="p-1">{dim.name}</td>
              {profile.level_sets.map((set) => {
                const lv = set.dimensions.find((x) => x.slug === dim.slug)?.levels[0]
                return (
                  <td key={set.id} className={`p-1 text-right ${levelHighlightClass(lv)}`}>
                    {lv?.level ?? '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ScoreForecast({ forecast, boldTop }: { forecast: CullReviewDetail['score_forecast']; boldTop: boolean }) {
  if (forecast.length === 0) return null
  const top = Math.max(...forecast.map((f) => f.p8 ?? -1))
  return (
    <section>
      <BlockHeading>{CULL_SCORE_FORECAST}</BlockHeading>
      <div className="space-y-1 text-sm">
        {forecast.map((f) =>
          f.p8 === null ? (
            <div key={f.name} className="flex justify-between gap-4 text-text-tertiary">
              <span>{f.name}</span>
              <span>{SCORE_FORECAST_DOES_NOT_APPLY}</span>
            </div>
          ) : (
            <div
              key={f.name}
              className={`flex justify-between gap-4 ${boldTop && f.p8 === top ? 'font-semibold' : ''}`}
            >
              <span>{f.name}</span>
              <span>{(f.p8 * 100).toFixed(1)}%</span>
            </div>
          ),
        )}
      </div>
    </section>
  )
}

function Verdict({ detail }: { detail: CullReviewDetail }) {
  if (detail.sent_by_hand) {
    return <StatusBlock tone="neutral" title={CULL_SENT_BY_HAND}>{CULL_SENT_BY_HAND_NOTE}</StatusBlock>
  }
  if (detail.verdict === 'passed') {
    return <StatusBlock tone="success" title={CULL_VERDICT_PASSED} />
  }
  return (
    <StatusBlock tone="warning" title={CULL_VERDICT_FILTERED}>
      {CULL_FILTERED_BY(detail.filtered_by)}
    </StatusBlock>
  )
}

function FrameStatus({ frame }: { frame: FrameSubstanceResponse }) {
  return (
    <StatusBlock tone={frameHeldBack(frame) ? 'warning' : 'neutral'} title={FRAME_SUBSTANCE_LABEL}>
      <p>{frameVerdictSummary(frame)}</p>
      {frame.is_stale ? <p className="text-warning">{FRAME_SUBSTANCE_STALE}</p> : null}
      {frame.instrument?.kind === 'excusal_channel' ? (
        <p className="text-xs text-text-tertiary">{FRAME_SUBSTANCE_ADVISORY_LABEL}</p>
      ) : null}
      {frame.instrument?.kind === 'pixel_detector' && frame.instrument.verdict ? (
        <p className="text-xs text-text-tertiary">
          Pixel detector · Tier {frame.instrument.tier} · {frame.instrument.verdict}
        </p>
      ) : null}
      {frame.has_override ? <p className="text-xs text-text-tertiary">{FRAME_SUBSTANCE_RESTORED}</p> : null}
    </StatusBlock>
  )
}

function CullingTabContent({
  imageKey,
  detail,
  onDataChanged,
}: {
  imageKey: string
  detail: CullReviewDetail | null
  onDataChanged?: () => void
}) {
  const frame = useQuery(...frameSubstanceQuery(imageKey))
  const { run: runCullingGate, dialog: cullingDialog } = useCullingGate()
  const [frameBusy, setFrameBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshVerdict = useCallback(() => {
    onDataChanged?.()
  }, [onDataChanged])

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      refreshVerdict()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleFrameOverride = async () => {
    setError(null)
    setFrameBusy(true)
    try {
      if (frame.has_override) await FrameSubstanceAPI.deleteOverride(imageKey)
      else await FrameSubstanceAPI.createOverride(imageKey)
      onDataChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update override')
    } finally {
      setFrameBusy(false)
    }
  }

  const showFrame = !frameSaysNothing(frame)
  const showRestore = frame.flagged || frame.has_override
  const askVerdict = detail && !detail.sent_by_hand
  const answeredNo = detail?.user_actions.some((a) => a.action === 'should_have_been_filtered') ?? false
  const agreed = detail?.user_actions.some((a) => a.action === 'agrees_with_filter') ?? false
  const sendLabel = detail
    ? rowSendButtonLabel({ completion: detail.completion, needs_send_work: detail.needs_send_work })
    : null

  return (
    <>
      {detail ? <Verdict detail={detail} /> : null}
      {showFrame ? <FrameStatus frame={frame} /> : null}
      {detail ? <ProfileReadings profile={detail.profile} /> : null}
      {detail ? <ScoreForecast forecast={detail.score_forecast} boldTop={detail.verdict === 'passed'} /> : null}

      <ActionArea>
        {askVerdict && detail.verdict === 'passed' ? (
          <ActionRow label={CULL_PASS_QUESTION} hint={CULL_PASS_HINT}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={!answeredNo}
              className={answeredNo ? '' : SELECTED_ANSWER_CLASS}
              onClick={() => answeredNo && void act(() => CullAPI.withdrawShouldHaveBeenFiltered(imageKey))}
            >
              {CULL_PASS_YES}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={answeredNo}
              className={answeredNo ? SELECTED_ANSWER_CLASS : ''}
              onClick={() => !answeredNo && void act(() => CullAPI.recordAction(imageKey, 'should_have_been_filtered'))}
            >
              {CULL_PASS_NO}
            </Button>
          </ActionRow>
        ) : null}
        {askVerdict && detail.verdict !== 'passed' ? (
          <ActionRow label={CULL_PASS_QUESTION}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={agreed}
              onClick={() => void act(() => CullAPI.recordAction(imageKey, 'agrees_with_filter'))}
            >
              {agreed ? CULL_AGREED : CULL_AGREE}
            </Button>
            {sendLabel ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() =>
                  void runCullingGate('send', () => act(() => CullAPI.sendPhotos([imageKey])))
                }
              >
                {sendLabel}
              </Button>
            ) : null}
          </ActionRow>
        ) : null}
        {showFrame && showRestore ? (
          <ActionRow
            label={FRAME_SUBSTANCE_LABEL}
            hint={!frame.has_override && frame.restore_tier === 'A' ? FRAME_SUBSTANCE_OVERRIDE_RESCORE_WARN : null}
          >
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={frameBusy}
              onClick={() => void toggleFrameOverride()}
            >
              {frameBusy ? '…' : frame.has_override ? 'Undo restore' : FRAME_SUBSTANCE_OVERRIDE_RESTORE}
            </Button>
          </ActionRow>
        ) : null}
        {error ? (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        ) : null}
      </ActionArea>
      {cullingDialog}
    </>
  )
}

function CullingTabWithVerdict(props: { imageKey: string; onDataChanged?: () => void }) {
  const detail = useQuery(keys.cull.detail(props.imageKey), () => CullAPI.photoDetail(props.imageKey))
  return <CullingTabContent {...props} detail={detail} />
}

/** The culling verdict (in culling views) and the frame substance reading. */
export function CullingTab({
  imageKey,
  showVerdict,
  onDataChanged,
}: {
  imageKey: string
  showVerdict: boolean
  onDataChanged?: () => void
}) {
  return showVerdict ? (
    <CullingTabWithVerdict imageKey={imageKey} onDataChanged={onDataChanged} />
  ) : (
    <CullingTabContent imageKey={imageKey} detail={null} onDataChanged={onDataChanged} />
  )
}
