import type { Provider, ProviderModel } from '../../services/api';
import { PROVIDERS_GROUP_SYSTEM_ONE, PROVIDERS_GROUP_SYSTEM_ONE_EMPTY } from '../../constants/strings';
import { ProviderCard } from './ProviderCard';
import { AddSystemOneProviderCard, type CreateSystemOneProviderPayload } from './AddSystemOneProviderCard';
import type { ProviderEditValues } from './ProviderEditForm';

interface SystemOneProvidersGroupProps {
  providers: Provider[];
  cullingStagesByProvider: Record<string, string[]>;
  expandedId: string | null;
  modelCache: Record<string, ProviderModel[]>;
  testingId: string | null;
  addressImpactByProvider: Record<string, { photos: number; stageNames: string[] } | null>;
  onToggle: (providerId: string) => void;
  onCreate: (payload: CreateSystemOneProviderPayload) => Promise<void>;
  onSaveProvider: (providerId: string, values: ProviderEditValues) => Promise<void>;
  onTestConnection: (providerId: string) => Promise<void>;
  onAddModel: (providerId: string, model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => void;
  onReorderModel: (providerId: string, modelId: string, direction: 'up' | 'down') => void;
  onBaseUrlChange: (providerId: string, url: string) => void;
}

export function SystemOneProvidersGroup({
  providers,
  cullingStagesByProvider,
  expandedId,
  modelCache,
  testingId,
  addressImpactByProvider,
  onToggle,
  onCreate,
  onSaveProvider,
  onTestConnection,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onBaseUrlChange,
}: SystemOneProvidersGroupProps) {
  return (
    <section id="system-one-providers" className="space-y-3 scroll-mt-6">
      <div className="rounded-card border border-border bg-surface overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-surface">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
            {PROVIDERS_GROUP_SYSTEM_ONE}
          </h4>
        </div>
        <div className="p-4 space-y-3">
          {providers.length === 0 ? (
            <p className="text-sm text-text-secondary">{PROVIDERS_GROUP_SYSTEM_ONE_EMPTY}</p>
          ) : (
            providers.map(provider => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                models={modelCache[provider.id] ?? []}
                cullingStageNames={cullingStagesByProvider[provider.id]}
                expanded={expandedId === provider.id}
                onToggle={() => onToggle(provider.id)}
                onAddModel={model => onAddModel(provider.id, model)}
                onRemoveModel={modelId => onRemoveModel(provider.id, modelId)}
                onReorderModel={(modelId, direction) => onReorderModel(provider.id, modelId, direction)}
                onSaveProvider={values => onSaveProvider(provider.id, values)}
                onTestConnection={() => onTestConnection(provider.id)}
                testingConnection={testingId === provider.id}
                addressChangeImpact={addressImpactByProvider[provider.id] ?? null}
                onBaseUrlChange={url => onBaseUrlChange(provider.id, url)}
              />
            ))
          )}
          <AddSystemOneProviderCard compact onCreate={onCreate} />
        </div>
      </div>
    </section>
  );
}
