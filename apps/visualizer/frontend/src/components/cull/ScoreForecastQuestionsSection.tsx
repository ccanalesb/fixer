import { useState } from 'react'
import { ScoreForecastQuestionsAPI } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
import { FoldingCard } from '../ui/Card'
import {
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  SCORE_FORECAST_QUESTIONS_ID,
  SFQ_HELP,
  SFQ_SECTION,
  SFQ_SUMMARY,
} from '../../constants/strings'
import { ScoreForecastQuestionsEditor } from './ScoreForecastQuestionsEditor'

export const SCORE_FORECAST_QUESTIONS_KEY = ['score-forecast-questions'] as const

/** Perspectives → Score forecast questions: what the Score forecast's model answers. */
export function ScoreForecastQuestionsSection() {
  const [rev, setRev] = useState(0)
  const current = useQuery([...SCORE_FORECAST_QUESTIONS_KEY, rev], () => ScoreForecastQuestionsAPI.get())
  const [impact, setImpact] = useState<{ photos: number; hours_estimate: number } | null>(null)

  const summary = SFQ_SUMMARY(
    current.questions.length,
    current.questions.filter((q) => q.optional).length,
    current.version,
  )

  return (
    <div className="mt-6">
      <FoldingCard
        id={SCORE_FORECAST_QUESTIONS_ID}
        title={SFQ_SECTION}
        summary={summary}
        storageKey="lt.perspectives.forecast-questions.open"
      >
        <p className="text-sm text-text-secondary mb-4">{SFQ_HELP}</p>
        <ScoreForecastQuestionsEditor
          key={current.version}
          current={current}
          onSaved={(res) => {
            setImpact(res.impact)
            invalidateAll(SCORE_FORECAST_QUESTIONS_KEY)
            setRev((n) => n + 1)
          }}
        />
        {impact ? (
          <p className="mt-2 text-xs text-warning">{CULL_PROFILE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
        ) : null}
      </FoldingCard>
    </div>
  )
}
