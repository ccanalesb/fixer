import type { Provider, ProviderModel } from '../../services/api';
import { PROVIDERS_GROUP_OPENAI } from '../../constants/strings';
import { AddProviderCard, type CreateProviderPayload } from './AddProviderCard';
import { ProviderCard } from './ProviderCard';
import type { ProviderEditValues } from './ProviderEditForm';

interface OpenAiProvidersGroupProps {
  providers: Provider[];
  expandedId: string | null;
  modelCache: Record<string, ProviderModel[]>;
  testingId: string | null;
  onToggle: (providerId: string) => void;
  onCreate: (payload: CreateProviderPayload) => Promise<void>;
  onSaveProvider: (providerId: string, values: ProviderEditValues) => Promise<void>;
  onTestConnection: (providerId: string) => Promise<void>;
  onAddModel: (providerId: string, model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => void;
  onReorderModel: (providerId: string, modelId: string, direction: 'up' | 'down') => void;
  onRetryModelImages?: (providerId: string, modelId: string) => void;
}

export function OpenAiProvidersGroup({
  providers,
  expandedId,
  modelCache,
  testingId,
  onToggle,
  onCreate,
  onSaveProvider,
  onTestConnection,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onRetryModelImages,
}: OpenAiProvidersGroupProps) {
  return (
    <section className="space-y-3">
      <div className="rounded-card border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-surface">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            {PROVIDERS_GROUP_OPENAI}
          </h4>
        </div>
        <div className="p-4 space-y-3">
          {providers.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              models={modelCache[provider.id] ?? []}
              expanded={expandedId === provider.id}
              onToggle={() => onToggle(provider.id)}
              onAddModel={model => onAddModel(provider.id, model)}
              onRemoveModel={modelId => onRemoveModel(provider.id, modelId)}
              onReorderModel={(modelId, direction) => onReorderModel(provider.id, modelId, direction)}
              onRetryModelImages={
                onRetryModelImages ? modelId => onRetryModelImages(provider.id, modelId) : undefined
              }
              onSaveProvider={values => onSaveProvider(provider.id, values)}
              onTestConnection={() => onTestConnection(provider.id)}
              testingConnection={testingId === provider.id}
            />
          ))}
          <AddProviderCard onCreate={onCreate} />
        </div>
      </div>
    </section>
  );
}
