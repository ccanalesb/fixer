import { Button } from '../ui/Button'
import {
  CULL_AGREE,
  CULL_AGREED,
  CULL_MANUALLY_CULL_NOTE,
  CULL_SCORE_FORECAST,
  CULL_SHOULD_HAVE_BEEN_CUT,
} from '../../constants/strings'
import { failingLevelClass } from './cullHighlight'
import { sendButtonLabel } from './sendLabel'
import type { CullReviewDetail } from '../../services/api'

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
  const sentByHand = detail.sent_by_hand
  const sendLabel = sendButtonLabel([detail.completion])

  return (
    <section className="mt-6 pt-6 border-t border-border space-y-4">
      <h3 className="font-semibold text-sm">Culling</h3>
      {sentByHand ? (
        <p className="text-sm text-text-secondary">{CULL_MANUALLY_CULL_NOTE}</p>
      ) : detail.verdict === 'sent' ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => onAction('should_have_been_cut')}>
          {CULL_SHOULD_HAVE_BEEN_CUT}
        </Button>
      ) : (
        <>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="text-left p-1" />
                {detail.recipe.level_sets.map((s) => (
                  <th key={s.id} className="p-1 text-right font-medium text-text-tertiary">
                    {s.id} levels
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.recipe.level_sets[0]?.dimensions.map((dim) => (
                <tr key={dim.slug}>
                  <td className="p-1">{dim.name}</td>
                  {detail.recipe.level_sets.map((set) => {
                    const d = set.dimensions.find((x) => x.slug === dim.slug)
                    const lv = d?.levels[0]
                    return (
                      <td key={set.id} className={`p-1 text-right ${failingLevelClass(lv?.fails ?? false)}`}>
                        {lv?.level ?? '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <h4 className="text-sm font-medium mb-2">{CULL_SCORE_FORECAST}</h4>
            <div className="space-y-1 text-sm">
              {detail.score_forecast.map((f) => (
                <div key={f.name} className="flex justify-between gap-4">
                  <span>{f.name}</span>
                  <span>{(f.p8 * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </div>
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
