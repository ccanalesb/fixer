import type { Provider, ProviderModel } from '../../services/api';
import {
  PROVIDER_STATUS_AVAILABLE,
  PROVIDER_STATUS_UNAVAILABLE,
  PROVIDER_MODELS_HEADING,
  PROVIDER_NO_MODELS,
} from '../../constants/strings';
import { Badge } from '../ui/badges';
import { ModelList } from './ModelList';
import { AddModelForm } from './AddModelForm';
import { ProviderEditForm, type ProviderEditValues } from './ProviderEditForm';
import { ProviderAddressProbe } from './ProviderAddressProbe';
import {
  PROVIDERS_SYSTEM_ONE_UNUSED,
  PROVIDERS_SYSTEM_ONE_USED_BY,
} from '../../constants/strings';

interface ProviderCardProps {
  provider: Provider;
  models: ProviderModel[];
  /** Culling stage display names that use this provider (System One). */
  cullingStageNames?: string[];
  expanded: boolean;
  onToggle: () => void;
  onAddModel: (model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (modelId: string) => void;
  onReorderModel: (modelId: string, direction: 'up' | 'down') => void;
  onRetryModelImages?: (modelId: string) => void;
  onSaveProvider: (values: ProviderEditValues) => Promise<void>;
  onTestConnection: () => Promise<void>;
  testingConnection?: boolean;
  addressChangeImpact?: { photos: number; stageNames: string[] } | null;
  onBaseUrlChange?: (url: string) => void;
}

export function ProviderCard({
  provider,
  models,
  expanded,
  onToggle,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onRetryModelImages,
  onSaveProvider,
  onTestConnection,
  testingConnection = false,
  cullingStageNames,
  addressChangeImpact = null,
  onBaseUrlChange,
}: ProviderCardProps) {
  const probeAnswered = provider.address_probe?.answered;
  const systemOneUsage =
    provider.protocol === 'system_one'
      ? cullingStageNames && cullingStageNames.length > 0
        ? PROVIDERS_SYSTEM_ONE_USED_BY(cullingStageNames.join(' and '))
        : PROVIDERS_SYSTEM_ONE_UNUSED
      : null;

  return (
    <div className="rounded-card border border-border bg-bg shadow-card">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between text-left rounded-t-card hover:bg-surface transition-colors duration-150"
      >
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="flex items-center gap-3 min-w-0">
          <h3 className="font-semibold text-text truncate">{provider.name}</h3>
          <Badge variant={provider.available ? 'success' : 'default'}>
            {provider.available ? PROVIDER_STATUS_AVAILABLE : PROVIDER_STATUS_UNAVAILABLE}
          </Badge>
          {probeAnswered === true && <Badge variant="success">Reachable</Badge>}
          {probeAnswered === false && (
            <span title={provider.address_probe?.error ?? undefined}>
              <Badge variant="error">Unreachable</Badge>
            </span>
          )}
          </div>
          {systemOneUsage ? (
            <p className="text-xs text-text-secondary truncate">{systemOneUsage}</p>
          ) : null}
        </div>
        <span className="text-text-tertiary text-sm shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          <ProviderEditForm
            provider={provider}
            onSave={onSaveProvider}
            onTestConnection={onTestConnection}
            testing={testingConnection}
            addressChangeImpact={addressChangeImpact}
            onBaseUrlChange={onBaseUrlChange}
          />
          <ProviderAddressProbe probe={provider.address_probe} />
          <h4 className="text-sm font-medium text-text mb-2 mt-4">{PROVIDER_MODELS_HEADING}</h4>
          {models.length === 0 ? (
            <p className="text-sm text-text-tertiary">{PROVIDER_NO_MODELS}</p>
          ) : (
            <ModelList
              models={models}
              onRemove={onRemoveModel}
              onReorder={onReorderModel}
              onRetryImages={onRetryModelImages}
            />
          )}
          <AddModelForm onAdd={onAddModel} />
        </div>
      )}
    </div>
  );
}
