import { Button } from '../ui/Button'
import {
  CULL_AGREE,
  CULL_AGREED,
  CULL_DETAIL_SECTION,
  CULL_MANUALLY_CULL_NOTE,
  CULL_PASSED,
  CULL_SCORE_FORECAST,
  CULL_SHOULD_HAVE_BEEN_CUT,
  CULL_SHOULD_HAVE_BEEN_CUT_MARKED,
} from '../../constants/strings'
import { levelHighlightClass } from './cullHighlight'
import { rowSendButtonLabel } from './sendLabel'
import type { CullReviewDetail } from '../../services/api'

function RecipeTable({ recipe }: { recipe: CullReviewDetail['recipe'] }) {
  return (
    <table className="w-full text-xs border-collapse">
      <thead>
        <tr>
          <th className="text-left p-1" />
          {recipe.level_sets.map((s) => (
            <th key={s.id} className="p-1 text-right font-medium text-text-tertiary">
              {s.id} levels
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {recipe.level_sets[0]?.dimensions.map((dim) => (
          <tr key={dim.slug}>
            <td className="p-1">{dim.name}</td>
            {recipe.level_sets.map((set) => {
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
  )
}

function ScoreForecast({ forecast, boldTop }: { forecast: CullReviewDetail['score_forecast']; boldTop: boolean }) {
  if (forecast.length === 0) return null
  const top = Math.max(...forecast.map((f) => f.p8))
  return (
    <div>
      <h4 className="text-sm font-medium mb-2">{CULL_SCORE_FORECAST}</h4>
      <div className="space-y-1 text-sm">
        {forecast.map((f) => (
          <div
            key={f.name}
            className={`flex justify-between gap-4 ${boldTop && f.p8 === top ? 'font-semibold' : ''}`}
          >
            <span>{f.name}</span>
            <span>{(f.p8 * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CullDetailSection({
  detail,
  onAction,
  onSend,
}: {
  detail: CullReviewDetail
  onAction: (action: 'agrees_with_cut' | 'should_have_been_cut') => void
  onSend: () => void
}) {
  const agreed = detail.user_actions.some((a) => a.action === 'agrees_with_cut')
  const markedShouldHaveBeenCut = detail.user_actions.some((a) => a.action === 'should_have_been_cut')
  const sentByHand = detail.sent_by_hand
  const sendLabel = rowSendButtonLabel({
    completion: detail.completion,
    needs_send_work: detail.needs_send_work,
  })

  return (
    <section className="mt-6 pt-6 border-t border-border space-y-4">
      <h3 className="font-semibold text-sm">{CULL_DETAIL_SECTION}</h3>
      {sentByHand ? (
        <p className="text-sm text-text-secondary">{CULL_MANUALLY_CULL_NOTE}</p>
      ) : detail.verdict === 'sent' ? (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold text-success">
            <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
            {CULL_PASSED}
          </p>
          {detail.recipe.level_sets.length > 0 ? (
            <div>
              <h4 className="text-sm font-medium mb-2">{detail.recipe.name}</h4>
              <RecipeTable recipe={detail.recipe} />
            </div>
          ) : null}
          <ScoreForecast forecast={detail.score_forecast} boldTop />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={markedShouldHaveBeenCut}
            onClick={() => onAction('should_have_been_cut')}
          >
            {markedShouldHaveBeenCut ? CULL_SHOULD_HAVE_BEEN_CUT_MARKED : CULL_SHOULD_HAVE_BEEN_CUT}
          </Button>
        </>
      ) : (
        <>
          <RecipeTable recipe={detail.recipe} />
          <ScoreForecast forecast={detail.score_forecast} boldTop={false} />
          <div className="flex flex-wrap gap-2">
            {sendLabel && (
              <Button type="button" size="sm" variant="primary" onClick={onSend}>
                {sendLabel}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={agreed}
              onClick={() => onAction('agrees_with_cut')}
            >
              {agreed ? CULL_AGREED : CULL_AGREE}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
