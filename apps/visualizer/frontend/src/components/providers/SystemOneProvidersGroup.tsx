import type { Job, Provider, ProviderModel } from '../../services/api';
import { PROVIDERS_GROUP_SYSTEM_ONE, PROVIDERS_GROUP_SYSTEM_ONE_EMPTY } from '../../constants/strings';
import { ProviderCard } from './ProviderCard';
import { AddSystemOneProviderCard, type CreateSystemOneProviderPayload } from './AddSystemOneProviderCard';
import type { ProviderEditValues } from './ProviderEditForm';

interface SystemOneProvidersGroupProps {
  providers: Provider[];
  allProviders: Provider[];
  fallbackOrder: string[];
  modelCache: Record<string, ProviderModel[]>;
  activeJobs: Job[];
  cullingStagesByProvider: Record<string, string[]>;
  expandedId: string | null;
  testingId: string | null;
  addressImpactByProvider: Record<string, { photos: number; stageNames: string[] } | null>;
  onToggle: (providerId: string) => void;
  onCreate: (payload: CreateSystemOneProviderPayload) => Promise<void>;
  onSaveProvider: (providerId: string, values: ProviderEditValues) => Promise<void>;
  onTestConnection: (providerId: string) => Promise<void>;
  onAddModel: (providerId: string, model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (providerId: string, modelId: string) => void;
  onReorderModel: (providerId: string, modelId: string, direction: 'up' | 'down') => void;
  onSetEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  onRequestRemove: (providerId: string) => void;
}

export function SystemOneProvidersGroup({
  providers,
  allProviders,
  fallbackOrder,
  modelCache,
  activeJobs,
  cullingStagesByProvider,
  expandedId,
  testingId,
  addressImpactByProvider,
  onToggle,
  onCreate,
  onSaveProvider,
  onTestConnection,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onSetEnabled,
  onRequestRemove,
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
                providers={allProviders}
                fallbackOrder={fallbackOrder}
                modelCache={modelCache}
                activeJobs={activeJobs}
                cullingStageNames={cullingStagesByProvider[provider.id]}
                expanded={expandedId === provider.id}
                onToggle={() => onToggle(provider.id)}
                onAddModel={model => onAddModel(provider.id, model)}
                onRemoveModel={modelId => onRemoveModel(provider.id, modelId)}
                onReorderModel={(modelId, direction) => onReorderModel(provider.id, modelId, direction)}
                onSaveProvider={values => onSaveProvider(provider.id, values)}
                onTestConnection={() => onTestConnection(provider.id)}
                onSetEnabled={enabled => onSetEnabled(provider.id, enabled)}
                onRequestRemove={() => onRequestRemove(provider.id)}
                testingConnection={testingId === provider.id}
                addressChangeImpact={addressImpactByProvider[provider.id] ?? null}
              />
            ))
          )}
          <AddSystemOneProviderCard compact onCreate={onCreate} />
        </div>
      </div>
    </section>
  );
}
