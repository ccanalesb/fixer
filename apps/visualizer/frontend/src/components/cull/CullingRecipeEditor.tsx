import { useState } from 'react'
import type { CullRecipeDetail } from '../../services/api'
import { CullingRecipesAPI } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_RECIPE_ACTIVATE,
  CULL_RECIPE_DEACTIVATE,
  CULL_RECIPE_TEXT_SAVE_IMPACT,
  CULL_RECIPE_UNMEASURED_HINT,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
} from '../../constants/strings'
import { CullingRecipeDefinitionFields } from './CullingRecipeDefinitionFields'
import { CullingRecipeRuleFields } from './CullingRecipeRuleFields'

type Draft = CullRecipeDetail

export function CullingRecipeEditor({
  recipe,
  onRefresh,
}: {
  recipe: CullRecipeDetail
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(recipe) as Draft)
  const [impact, setImpact] = useState<{ photos: number; hours_estimate: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const setDefinition = (fn: (d: Draft['definition']) => Draft['definition']) => {
    setDraft((d) => ({ ...d, definition: fn(d.definition) }))
  }
  const setRule = (fn: (r: Draft['rule']) => Draft['rule']) => {
    setDraft((d) => ({ ...d, rule: fn(d.rule) }))
  }

  const saveMeta = async () => {
    await CullingRecipesAPI.patch(draft.slug, { name: draft.name })
    onRefresh()
  }

  const saveRule = async () => {
    setError(null)
    await CullingRecipesAPI.saveRule(draft.slug, draft.rule)
    onRefresh()
  }

  const saveDefinition = async (mode: 'save_only' | 'save_and_queue_cull') => {
    setError(null)
    try {
      const res = await CullingRecipesAPI.saveDefinition(draft.slug, {
        definition: draft.definition,
        mode,
      })
      if (res.impact) setImpact(res.impact)
      onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4 text-sm border border-border rounded-base p-4">
      {!draft.measured ? (
        <p className="text-warning text-xs">{CULL_NOT_MEASURED}. {CULL_RECIPE_UNMEASURED_HINT}</p>
      ) : null}
      {error ? <p className="text-error text-xs">{error}</p> : null}

      <CullingRecipeDefinitionFields
        draft={draft}
        setDefinition={setDefinition}
        setRule={setRule}
        onNameChange={(name) => setDraft((d) => ({ ...d, name }))}
        onNameBlur={() => void saveMeta()}
      />

      <CullingRecipeRuleFields draft={draft} setRule={setRule} />

      <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
      {impact ? (
        <p className="text-xs text-warning">{CULL_RECIPE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void saveRule()}>
          {CULL_SAVE}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => void saveDefinition('save_only')}>
          {CULL_SAVE_ONLY}
        </Button>
        <Button type="button" size="sm" variant="primary" onClick={() => void saveDefinition('save_and_queue_cull')}>
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
    </div>
  )
}
