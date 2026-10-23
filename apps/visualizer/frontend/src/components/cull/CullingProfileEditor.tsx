import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { CullProfileDetail } from '../../services/api'
import { ApiRequestError, CullingProfilesAPI } from '../../services/api'
import { Button } from '../ui/Button'
import {
  CULL_DUPLICATE,
  CULL_NOT_MEASURED,
  CULL_PROFILE_ACTIVATE,
  CULL_PROFILE_ACTIVATE_CONFIRM,
  CULL_PROFILE_ACTIVATE_CONFIRM_TITLE,
  CULL_PROFILE_DEACTIVATE,
  CULL_PROFILE_DEACTIVATE_CONFIRM,
  CULL_PROFILE_DEACTIVATE_CONFIRM_TITLE,
  CULL_PROFILE_DEFINITION_CHANGED,
  CULL_PROFILE_NAME,
  CULL_PROFILE_TAB_DIMENSIONS,
  CULL_PROFILE_TAB_LEVELS,
  CULL_PROFILE_TAB_RULE,
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  CULL_PROFILE_UNMEASURED_HINT,
  CULL_RULE_SAVE_CONFIRM,
  CULL_RULE_SAVE_CONFIRM_TITLE,
  CULL_RULE_SAVE_NOTE,
  CULL_SAVE,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
  CULL_SAVED_NO_JOB,
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../constants/strings'
import { CullingProfileDimensionsFields } from './CullingProfileDimensionsFields'
import { CullingProfileLevelsFields } from './CullingProfileLevelsFields'
import { CullingProfileRuleFields } from './CullingProfileRuleFields'
import { RedecideConfirmDialog } from './RedecideConfirmDialog'
import { Segmented } from './Segmented'
import { bandProblems, emptyLevelCount } from './profileDraft'

type Draft = CullProfileDetail
type Tab = 'dimensions' | 'levels' | 'rule'
type RedecideChange = 'rule' | 'active'
type Redecided = { pipeline_setting_version: number | null; redecide_job_id: string | null }

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
  const [confirming, setConfirming] = useState<RedecideChange | null>(null)
  const [redecided, setRedecided] = useState<Redecided | null>(null)

  const setDefinition = (fn: (d: Draft['definition']) => Draft['definition']) => {
    setDraft((d) => ({ ...d, definition: fn(d.definition) }))
  }
  const setRule = (fn: (r: Draft['rule']) => Draft['rule']) => {
    setRedecided(null)
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

  const applyRedecideChange = async (change: RedecideChange) => {
    setConfirming(null)
    setError(null)
    setFieldErrors({})
    setRedecided(null)
    try {
      if (change === 'rule') {
        setRedecided(await CullingProfilesAPI.saveRule(draft.slug, draft.rule))
      } else {
        const res = await CullingProfilesAPI.patch(draft.slug, { active: !draft.active })
        setDraft((d) => ({ ...d, active: res.profile.active }))
        setRedecided(res)
      }
      onRefresh()
    } catch (e) {
      showErrors(e)
    }
  }

  const redecidedNote = () => {
    if (!redecided) return null
    if (redecided.pipeline_setting_version === null) {
      return <p className="text-sm text-success">{CULL_SAVED_NO_JOB}</p>
    }
    return (
      <p className="text-sm text-success">
        {redecided.redecide_job_id ? CULLING_MODELS_SAVED : CULLING_MODELS_SAVED_JOB_WAITING}{' '}
        <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-accent underline">
          {CULLING_MODELS_VIEW_QUEUE}
        </Link>
      </p>
    )
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
          <CullingProfileRuleFields draft={draft} setRule={setRule} />
        ) : null}
      </div>

      <p className="text-text-secondary text-xs">{CULL_RULE_SAVE_NOTE}</p>
      {impact ? (
        <p className="text-xs text-warning">{CULL_PROFILE_TEXT_SAVE_IMPACT(impact.photos, impact.hours_estimate)}</p>
      ) : null}
      {redecidedNote()}

      <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={definitionChanged || bandsBad}
          onClick={() => setConfirming('rule')}
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
          onClick={() => setConfirming('active')}
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
      {confirming ? (
        <RedecideConfirmDialog
          title={
            confirming === 'rule'
              ? CULL_RULE_SAVE_CONFIRM_TITLE
              : draft.active
                ? CULL_PROFILE_DEACTIVATE_CONFIRM_TITLE
                : CULL_PROFILE_ACTIVATE_CONFIRM_TITLE
          }
          confirmLabel={
            confirming === 'rule'
              ? CULL_RULE_SAVE_CONFIRM
              : draft.active
                ? CULL_PROFILE_DEACTIVATE_CONFIRM
                : CULL_PROFILE_ACTIVATE_CONFIRM
          }
          onCancel={() => setConfirming(null)}
          onConfirm={() => void applyRedecideChange(confirming)}
        />
      ) : null}
    </div>
  )
}
