import { useState } from 'react'
import type { CullRecipeDetail } from '../../services/api'
import { ApiRequestError, CullingRecipesAPI } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_RECIPE_ACTIVATE,
  CULL_RECIPE_DEACTIVATE,
  CULL_RECIPE_DEFINITION_CHANGED,
  CULL_RECIPE_NAME,
  CULL_RECIPE_TAB_DIMENSIONS,
  CULL_RECIPE_TAB_LEVELS,
  CULL_RECIPE_TAB_RULE,
  CULL_RECIPE_TEXT_SAVE_IMPACT,
  CULL_RECIPE_UNMEASURED_HINT,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
} from '../../constants/strings'
import { CullingRecipeDimensionsFields } from './CullingRecipeDimensionsFields'
import { CullingRecipeLevelsFields } from './CullingRecipeLevelsFields'
import { CullingRecipeRuleFields } from './CullingRecipeRuleFields'
import { ScoreForecastThresholdField } from './ScoreForecastThresholdField'
import { Segmented } from './Segmented'
import { bandProblems, emptyLevelCount } from './recipeDraft'

type Draft = CullRecipeDetail
type Tab = 'dimensions' | 'levels' | 'rule'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function CullingRecipeEditor({
  recipe,
  onRefresh,
}: {
  recipe: CullRecipeDetail
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(recipe) as Draft)
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

  const definitionChanged = !same(draft.definition, recipe.definition)
  const ruleChanged = !same(draft.rule, recipe.rule)
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
    await CullingRecipesAPI.patch(draft.slug, { name: draft.name })
    onRefresh()
  }

  const saveRule = async () => {
    setError(null)
    setFieldErrors({})
    try {
      await CullingRecipesAPI.saveRule(draft.slug, draft.rule)
      onRefresh()
    } catch (e) {
      showErrors(e)
    }
  }

  const saveDefinition = async (mode: 'save_only' | 'save_and_queue_cull') => {
    setError(null)
    setFieldErrors({})
    try {
      const res = await CullingRecipesAPI.saveDefinition(draft.slug, {
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
        <p className="text-warning text-xs">{CULL_NOT_MEASURED}. {CULL_RECIPE_UNMEASURED_HINT}</p>
      ) : null}
      {error ? <p className="text-error text-xs">{error}</p> : null}

      <div>
        <label className="block sm:max-w-md font-medium text-text-secondary">
          {CULL_RECIPE_NAME}
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
        label="Recipe sections"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'dimensions', label: CULL_RECIPE_TAB_DIMENSIONS },
          { id: 'levels', label: CULL_RECIPE_TAB_LEVELS },
          { id: 'rule', label: CULL_RECIPE_TAB_RULE },
        ]}
      />

      <div role="tabpanel">
        {tab === 'dimensions' ? (
          <CullingRecipeDimensionsFields draft={draft} setDefinition={setDefinition} fieldErrors={fieldErrors} />
        ) : null}
        {tab === 'levels' ? (
          <CullingRecipeLevelsFields draft={draft} setDraft={setDraft} fieldErrors={fieldErrors} />
        ) : null}
        {tab === 'rule' ? (
          <div className="space-y-4">
            <CullingRecipeRuleFields draft={draft} setRule={setRule} />
            <ScoreForecastThresholdField />
          </div>
        ) : null}
      </div>

      <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
      {impact ? (
        <p className="text-xs text-warning">{CULL_RECIPE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
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
          onClick={() => void CullingRecipesAPI.patch(draft.slug, { active: !draft.active }).then(onRefresh)}
        >
          {draft.active ? CULL_RECIPE_DEACTIVATE : CULL_RECIPE_ACTIVATE}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            const newSlug = `${draft.slug}-copy`
            void CullingRecipesAPI.duplicate(draft.slug, { new_slug: newSlug }).then(onRefresh)
          }}
        >
          {CULL_DUPLICATE}
        </Button>
      </div>
      {definitionChanged ? <p className="text-xs text-text-tertiary">{CULL_RECIPE_DEFINITION_CHANGED}</p> : null}
    </div>
  )
}
