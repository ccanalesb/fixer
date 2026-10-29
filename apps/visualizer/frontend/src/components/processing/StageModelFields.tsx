import { Link } from 'react-router-dom'
import type { CullingStageKind } from '../../services/api'
import {
  PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE,
  STAGE_ADD_MODEL,
  STAGE_ENDPOINT,
  STAGE_ENDPOINT_PARKED,
  STAGE_ENDPOINT_THIS_APP,
  STAGE_MODEL,
  STAGE_MODEL_CHOOSE,
  STAGE_MODEL_CONVERTING,
  STAGE_MODEL_NONE_FOR_PROVIDER,
  STAGE_MODEL_NONE_IN_APP,
  STAGE_PROVIDERS_LINK,
} from '../../constants/strings'
import { offeredModels, shownModel, type StageView } from './stageModelView'

const field = 'border border-border rounded-base px-2.5 py-1.5 bg-bg text-sm text-text min-w-0'
const label = 'text-sm font-medium text-text-secondary'

interface StageModelFieldsProps {
  kind: CullingStageKind
  view: StageView
  busy: boolean
  onEndpoint: (endpoint: string) => void
  onModel: (model: string | null) => void
  onAddModel: () => void
}

function providerOptionLabel(v: StageView, id: string): string {
  const p = v.providers.find((x) => x.id === id)
  if (!p) return id
  const parked = p.enabled ? '' : ` ${STAGE_ENDPOINT_PARKED}`
  return `${p.name} (${p.url})${parked}`
}

/** One stage's endpoint (this app or a System One provider) and model. */
export function StageModelFields({ kind, view, busy, onEndpoint, onModel, onAddModel }: StageModelFieldsProps) {
  const models = offeredModels(view)
  const model = shownModel(view)
  const id = (part: string) => `${kind}-${part}`
  const onProvider = view.saved.endpoint !== 'this_app'

  return (
    <div className="grid grid-cols-[160px_1fr] items-center gap-x-3 gap-y-2">
      <label htmlFor={id('endpoint')} className={label}>
        {STAGE_ENDPOINT}
      </label>
      <div className="flex flex-col gap-1">
        <select
          id={id('endpoint')}
          className={`${field} justify-self-start max-w-full`}
          value={view.saved.endpoint}
          disabled={busy}
          onChange={(e) => onEndpoint(e.target.value)}
        >
          <option value="this_app">{STAGE_ENDPOINT_THIS_APP}</option>
          {view.providers.map((p) => (
            <option key={p.id} value={p.id}>
              {providerOptionLabel(view, p.id)}
            </option>
          ))}
        </select>
        <Link to={PROCESSING_PROVIDERS_SYSTEM_ONE_ROUTE} className="text-sm text-accent underline w-fit">
          {STAGE_PROVIDERS_LINK}
        </Link>
      </div>

      <label htmlFor={id('model')} className={label}>
        {STAGE_MODEL}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={id('model')}
          className={field}
          value={model && models.some((m) => m.name === model) ? model : ''}
          disabled={busy || (onProvider && view.providerModels === null) || models.length === 0}
          onChange={(e) => onModel(e.target.value || null)}
        >
          {models.length === 0 ? (
            <option value="">
              {onProvider ? STAGE_MODEL_NONE_FOR_PROVIDER : STAGE_MODEL_NONE_IN_APP}
            </option>
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
        {!onProvider && (
          <button type="button" className="text-sm text-accent underline" onClick={onAddModel}>
            {STAGE_ADD_MODEL}
          </button>
        )}
      </div>
    </div>
  )
}
