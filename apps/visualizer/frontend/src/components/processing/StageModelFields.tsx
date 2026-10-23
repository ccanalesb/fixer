import type { CullingStageKind } from '../../services/api'
import { Button } from '../ui/Button'
import {
  STAGE_ADD_MODEL,
  STAGE_API_KEY,
  STAGE_API_KEY_OPTIONAL,
  STAGE_API_KEY_REMOVE,
  STAGE_API_KEY_SAVED,
  STAGE_CHECK,
  STAGE_CHECK_ANSWERS,
  STAGE_CHECK_NO_ANSWER,
  STAGE_CHECKING,
  STAGE_ENDPOINT,
  STAGE_ENDPOINT_OTHER,
  STAGE_ENDPOINT_THIS_APP,
  STAGE_MODEL,
  STAGE_MODEL_CHECK_FIRST,
  STAGE_MODEL_CHOOSE,
  STAGE_MODEL_CONVERTING,
  STAGE_MODEL_NONE_IN_APP,
  STAGE_URL,
  STAGE_URL_PLACEHOLDER,
} from '../../constants/strings'
import { offeredModels, shownModel, type EndpointDraft, type StageView } from './stageModelView'

const field = 'border border-border rounded-base px-2.5 py-1.5 bg-bg text-sm text-text min-w-0'
const label = 'text-sm font-medium text-text-secondary'

interface StageModelFieldsProps {
  kind: CullingStageKind
  view: StageView
  busy: boolean
  onEndpoint: (other: boolean) => void
  onDraft: (change: Partial<EndpointDraft>) => void
  onCheck: () => void
  onRemoveKey: () => void
  onModel: (model: string | null) => void
  onAddModel: () => void
}

/** One stage's endpoint ("This app" or another System One URL, with Check and an API key) and model. */
export function StageModelFields({
  kind,
  view,
  busy,
  onEndpoint,
  onDraft,
  onCheck,
  onRemoveKey,
  onModel,
  onAddModel,
}: StageModelFieldsProps) {
  const { draft, check, saved } = view
  const models = offeredModels(view)
  const model = shownModel(view)
  const id = (part: string) => `${kind}-${part}`

  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-x-3 gap-y-2">
      <label htmlFor={id('endpoint')} className={label}>
        {STAGE_ENDPOINT}
      </label>
      <select
        id={id('endpoint')}
        className={`${field} justify-self-start`}
        value={draft.other ? 'other' : 'this_app'}
        disabled={busy}
        onChange={(e) => onEndpoint(e.target.value === 'other')}
      >
        <option value="this_app">{STAGE_ENDPOINT_THIS_APP}</option>
        <option value="other">{STAGE_ENDPOINT_OTHER}</option>
      </select>

      {draft.other && (
        <>
          <label htmlFor={id('url')} className={label}>
            {STAGE_URL}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={id('url')}
              className={`${field} flex-1`}
              placeholder={STAGE_URL_PLACEHOLDER}
              value={draft.url}
              onChange={(e) => onDraft({ url: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCheck()
              }}
            />
            <Button type="button" size="sm" variant="secondary" onClick={onCheck} disabled={busy}>
              {STAGE_CHECK}
            </Button>
            {check?.status === 'checking' && <span className="text-xs text-text-tertiary">{STAGE_CHECKING}</span>}
            {check?.status === 'ok' && <span className="text-sm text-success">{STAGE_CHECK_ANSWERS(check.models.length)}</span>}
            {check?.status === 'down' && (
              <span className="text-sm text-error" title={check.error}>
                {STAGE_CHECK_NO_ANSWER}
              </span>
            )}
          </div>
          <label htmlFor={id('api-key')} className={label}>
            {STAGE_API_KEY}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={id('api-key')}
              type="password"
              autoComplete="off"
              className={`${field} flex-1`}
              placeholder={saved.has_api_key ? STAGE_API_KEY_SAVED : STAGE_API_KEY_OPTIONAL}
              value={draft.key}
              onChange={(e) => onDraft({ key: e.target.value })}
            />
            {saved.has_api_key && (
              <Button type="button" size="sm" variant="secondary" onClick={onRemoveKey} disabled={busy}>
                {STAGE_API_KEY_REMOVE}
              </Button>
            )}
          </div>
        </>
      )}

      <label htmlFor={id('model')} className={label}>
        {STAGE_MODEL}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id('model')}
          className={field}
          value={model && models.some((m) => m.name === model) ? model : ''}
          disabled={busy || models.length === 0}
          onChange={(e) => onModel(e.target.value || null)}
        >
          {models.length === 0 ? (
            <option value="">{draft.other ? STAGE_MODEL_CHECK_FIRST : STAGE_MODEL_NONE_IN_APP}</option>
          ) : (
            <>
              <option value="">{STAGE_MODEL_CHOOSE}</option>
              {models.map((m) => (
                <option key={m.name} value={m.name} disabled={!m.ready}>
                  {m.ready ? m.name : STAGE_MODEL_CONVERTING(m.name)}
                </option>
              ))}
            </>
          )}
        </select>
        {!draft.other && (
          <button type="button" className="text-sm text-accent underline" onClick={onAddModel}>
            {STAGE_ADD_MODEL}
          </button>
        )}
      </div>
    </div>
  )
}
