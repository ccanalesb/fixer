import type { Job, Provider, ProviderModel } from '../../services/api';
import { PROVIDERS_GROUP_OPENAI } from '../../constants/strings';
import { AddProviderCard, type CreateProviderPayload } from './AddProviderCard';
import { ProviderCard } from './ProviderCard';
import type { ProviderEditValues } from './ProviderEditForm';

interface OpenAiProvidersGroupProps {
  providers: Provider[];
  allProviders: Provider[];
  fallbackOrder: string[];
  modelCache: Record<string, ProviderModel[]>;
  activeJobs: Job[];
  expandedId: string | null;
  testingId: string | null;
  onToggle: (providerId: string) => void;
  onCreate: (payload: CreateProviderPayload) => Promise<void>;
  onSaveProvider: (providerId: string, values: ProviderEditValues) => Promise<void>;
  onTestConnection: (providerId: string) => Promise<void>;
  onAddModel: (providerId: string, model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => void;
  onReorderModel: (providerId: string, modelId: string, direction: 'up' | 'down') => void;
  onRetryModelImages?: (providerId: string, modelId: string) => void;
  onSetEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  onRequestRemove: (providerId: string) => void;
}

export function OpenAiProvidersGroup({
  providers,
  allProviders,
  fallbackOrder,
  modelCache,
  activeJobs,
  expandedId,
  testingId,
  onToggle,
  onCreate,
  onSaveProvider,
  onTestConnection,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onRetryModelImages,
  onSetEnabled,
  onRequestRemove,
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
              providers={allProviders}
              fallbackOrder={fallbackOrder}
              modelCache={modelCache}
              activeJobs={activeJobs}
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
              onSetEnabled={enabled => onSetEnabled(provider.id, enabled)}
              onRequestRemove={() => onRequestRemove(provider.id)}
              testingConnection={testingId === provider.id}
            />
          ))}
          <AddProviderCard onCreate={onCreate} />
        </div>
      </div>
    </section>
  );
}
