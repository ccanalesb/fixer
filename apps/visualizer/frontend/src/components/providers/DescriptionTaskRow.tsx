import { useEffect, useState } from 'react'
import type { Provider, ProviderModel } from '../../services/api'
import { PROVIDER_DESCRIPTIONS_WILL_NOT_RUN, TASK_DESCRIPTIONS, TASK_DESCRIPTIONS_SUB } from '../../constants/strings'
import { ProviderModelSelect } from '../ui/ProviderModelSelect'
import { anyPhotoProvider } from './providerUsability'
import { TaskFallbackOrder } from './TaskFallbackOrder'

interface DescriptionTaskRowProps {
  providers: Provider[]
  fallbackOrder: string[]
  modelCache: Record<string, ProviderModel[]>
  descriptionProvider: string | null
  descriptionModel: string | null
  defaultsNotice: string | null
  onDescriptionChange: (providerId: string | null, modelId: string | null) => void
  onSave: () => void
  onReorderFallback: (order: string[]) => void
  saveMessage: string | null
}

export function DescriptionTaskRow({
  providers,
  fallbackOrder,
  modelCache,
  descriptionProvider,
  descriptionModel,
  defaultsNotice,
  onDescriptionChange,
  onSave,
  onReorderFallback,
  saveMessage,
}: DescriptionTaskRowProps) {
  const canRun = anyPhotoProvider(providers, fallbackOrder, modelCache)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setDirty(false)
  }, [descriptionProvider, descriptionModel])

  const handleChange = (providerId: string | null, modelId: string | null) => {
    onDescriptionChange(providerId, modelId)
    setDirty(true)
  }

  const save = () => {
    onSave()
    setDirty(false)
  }

  return (
    <div id="task-description" className="px-4 py-4">
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <div>
          <div className="text-sm font-semibold text-text">{TASK_DESCRIPTIONS}</div>
          <div className="text-xs text-text-tertiary">{TASK_DESCRIPTIONS_SUB}</div>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          {defaultsNotice ? (
            <p className="text-sm text-warning" role="status">
              {defaultsNotice}
            </p>
          ) : null}
          {!canRun ? (
            <p className="text-sm text-error" role="status">
              {PROVIDER_DESCRIPTIONS_WILL_NOT_RUN}
            </p>
          ) : null}
          <ProviderModelSelect
            providerId={descriptionProvider}
            modelId={descriptionModel}
            onChange={handleChange}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center rounded-base border border-border bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              disabled={!canRun || !descriptionProvider || !dirty}
              onClick={save}
            >
              Save
            </button>
            {saveMessage ? (
              <span className="text-sm text-success" role="status">
                {saveMessage}
              </span>
            ) : null}
          </div>
          <TaskFallbackOrder providers={providers} order={fallbackOrder} onReorder={onReorderFallback} />
        </div>
      </div>
    </div>
  )
}
