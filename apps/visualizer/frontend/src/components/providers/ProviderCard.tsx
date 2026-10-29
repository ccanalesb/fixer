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

interface ProviderCardProps {
  provider: Provider;
  models: ProviderModel[];
  expanded: boolean;
  onToggle: () => void;
  onAddModel: (model: { id: string; name: string; vision: boolean }) => Promise<void>;
  onRemoveModel: (modelId: string) => void;
  onReorderModel: (modelId: string, direction: 'up' | 'down') => void;
  onRetryModelImages?: (modelId: string) => void;
  /** null = probe not completed yet */
  connectionReachable?: boolean | null;
  connectionError?: string | null;
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
  connectionReachable = null,
  connectionError = null,
}: ProviderCardProps) {
  return (
    <div className="rounded-card border border-border bg-bg shadow-card">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between text-left rounded-t-card hover:bg-surface transition-colors duration-150"
      >
        <div className="flex items-center gap-3 min-w-0">
          <h3 className="font-semibold text-text truncate">{provider.name}</h3>
          <Badge variant={provider.available ? 'success' : 'default'}>
            {provider.available ? PROVIDER_STATUS_AVAILABLE : PROVIDER_STATUS_UNAVAILABLE}
          </Badge>
          {connectionReachable === true && (
            <Badge variant="success">Reachable</Badge>
          )}
          {connectionReachable === false && (
            <span title={connectionError ?? undefined}>
              <Badge variant="error">Unreachable</Badge>
            </span>
          )}
        </div>
        <span className="text-text-tertiary text-sm shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3">
          <h4 className="text-sm font-medium text-text mb-2">{PROVIDER_MODELS_HEADING}</h4>
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
