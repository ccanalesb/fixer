import { useState } from 'react'
import type { CullProfileDetail } from '../../services/api'
import { ApiRequestError, CullingProfilesAPI } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_PROFILE_ACTIVATE,
  CULL_PROFILE_DEACTIVATE,
  CULL_PROFILE_DEFINITION_CHANGED,
  CULL_PROFILE_NAME,
  CULL_PROFILE_TAB_DIMENSIONS,
  CULL_PROFILE_TAB_LEVELS,
  CULL_PROFILE_TAB_RULE,
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  CULL_PROFILE_UNMEASURED_HINT,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
} from '../../constants/strings'
import { CullingProfileDimensionsFields } from './CullingProfileDimensionsFields'
import { CullingProfileLevelsFields } from './CullingProfileLevelsFields'
import { CullingProfileRuleFields } from './CullingProfileRuleFields'
import { ScoreForecastThresholdField } from './ScoreForecastThresholdField'
import { Segmented } from './Segmented'
import { bandProblems, emptyLevelCount } from './profileDraft'

type Draft = CullProfileDetail
type Tab = 'dimensions' | 'levels' | 'rule'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function CullingProfileEditor({
  profile,
  onRefresh,
}: {
  profile: CullProfileDetail
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(profile) as Draft)
  const [tab, setTab] = useState<Tab>('dimensions')
  const [impact, setImpact] = useState<{ photos: number; hours_estimate: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const setDefinition = (fn: (d: Draft['definition']) => Draft['definition']) => {
    setDraft((d) => ({ ...d, definition: fn(d.definition) }))
  }
  const setRule = (fn: (r: Draft['rule']) => Draft['rule']) => {
    setDraft((d) => ({ ...d, rule: fn(d.rule) }))
  }

  const definitionChanged = !same(draft.definition, profile.definition)
  const ruleChanged = !same(draft.rule, profile.rule)
  const bandsBad = bandProblems(draft).length > 0
  const definitionBlocked = bandsBad || emptyLevelCount(draft) > 0

  const showErrors = (e: unknown) => {
    if (e instanceof ApiRequestError && e.validationErrors.length > 0) {
      const map: Record<string, string> = {}
      for (const ve of e.validationErrors) map[ve.field] = ve.message
      setFieldErrors(map)
    }
    setError(e instanceof Error ? e.message : String(e))
  }

  const saveMeta = async () => {
    await CullingProfilesAPI.patch(draft.slug, { name: draft.name })
    onRefresh()
  }

  const saveRule = async () => {
    setError(null)
    setFieldErrors({})
    try {
      await CullingProfilesAPI.saveRule(draft.slug, draft.rule)
      onRefresh()
    } catch (e) {
      showErrors(e)
    }
  }

  const saveDefinition = async (mode: 'save_only' | 'save_and_queue_cull') => {
    setError(null)
    setFieldErrors({})
    try {
      const res = await CullingProfilesAPI.saveDefinition(draft.slug, {
        definition: draft.definition,
        ...(ruleChanged ? { rule: draft.rule } : {}),
        mode,
      })
      setImpact(res.impact)
      onRefresh()
    } catch (e) {
      showErrors(e)
    }
  }

  return (
    <div className="space-y-4 text-sm border border-border rounded-base p-4">
      {!draft.measured ? (
        <p className="text-warning text-xs">{CULL_NOT_MEASURED}. {CULL_PROFILE_UNMEASURED_HINT}</p>
      ) : null}
      {error ? <p className="text-error text-xs">{error}</p> : null}

      <div>
        <label className="block sm:max-w-md font-medium text-text-secondary">
          {CULL_PROFILE_NAME}
          <input
            className="mt-1 w-full border border-border rounded-base px-2 py-1 bg-bg text-text font-normal"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            onBlur={() => void saveMeta()}
          />
        </label>
        <p className="text-text-tertiary text-xs mt-1">
          {draft.slug} · v{draft.version}
        </p>
      </div>

      <Segmented<Tab>
        asTabs
        label="Profile sections"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'dimensions', label: CULL_PROFILE_TAB_DIMENSIONS },
          { id: 'levels', label: CULL_PROFILE_TAB_LEVELS },
          { id: 'rule', label: CULL_PROFILE_TAB_RULE },
        ]}
      />

      <div role="tabpanel">
        {tab === 'dimensions' ? (
          <CullingProfileDimensionsFields draft={draft} setDefinition={setDefinition} fieldErrors={fieldErrors} />
        ) : null}
        {tab === 'levels' ? (
          <CullingProfileLevelsFields draft={draft} setDraft={setDraft} fieldErrors={fieldErrors} />
        ) : null}
        {tab === 'rule' ? (
          <div className="space-y-4">
            <CullingProfileRuleFields draft={draft} setRule={setRule} />
            <ScoreForecastThresholdField />
          </div>
        ) : null}
      </div>

      <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
      {impact ? (
        <p className="text-xs text-warning">{CULL_PROFILE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={definitionChanged || bandsBad}
          onClick={() => void saveRule()}
        >
          {CULL_SAVE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!definitionChanged || definitionBlocked}
          onClick={() => void saveDefinition('save_only')}
        >
          {CULL_SAVE_ONLY}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!definitionChanged || definitionBlocked}
          onClick={() => void saveDefinition('save_and_queue_cull')}
        >
          {CULL_SAVE_AND_QUEUE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void CullingProfilesAPI.patch(draft.slug, { active: !draft.active }).then(onRefresh)}
        >
          {draft.active ? CULL_PROFILE_DEACTIVATE : CULL_PROFILE_ACTIVATE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            const newSlug = `${draft.slug}-copy`
            void CullingProfilesAPI.duplicate(draft.slug, { new_slug: newSlug }).then(onRefresh)
          }}
        >
          {CULL_DUPLICATE}
        </Button>
      </div>
      {definitionChanged ? <p className="text-xs text-text-tertiary">{CULL_PROFILE_DEFINITION_CHANGED}</p> : null}
    </div>
  )
}
