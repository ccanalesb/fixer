import type { ProviderModel } from '../../services/api';
import {
  PROVIDER_COL_ACTIONS,
  PROVIDER_COL_MODEL,
  PROVIDER_COL_SOURCE,
  PROVIDER_COL_VISION,
  PROVIDER_MODEL_NO_IMAGES,
  PROVIDER_MODEL_TRY_AGAIN,
  PROVIDER_REMOVE_MODEL,
  PROVIDER_SOURCE_CONFIG,
  PROVIDER_SOURCE_DISCOVERED,
  PROVIDER_SOURCE_USER,
} from '../../constants/strings';
import { Button } from '../ui/Button';

const SOURCE_LABELS: Record<string, string> = {
  config: PROVIDER_SOURCE_CONFIG,
  discovered: PROVIDER_SOURCE_DISCOVERED,
  user: PROVIDER_SOURCE_USER,
};

interface ModelListProps {
  models: ProviderModel[];
  onRemove: (modelId: string) => void;
  onReorder: (modelId: string, direction: 'up' | 'down') => void;
  onRetryImages?: (modelId: string) => void;
}

export function ModelList({ models, onRemove, onReorder, onRetryImages }: ModelListProps) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-text-secondary text-xs uppercase tracking-wider">
          <th className="pb-1">{PROVIDER_COL_MODEL}</th>
          <th className="pb-1">{PROVIDER_COL_VISION}</th>
          <th className="pb-1">{PROVIDER_COL_SOURCE}</th>
          <th className="pb-1 w-20 text-right font-normal">{PROVIDER_COL_ACTIONS}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {models.map((model, index) => {
          const marked = model.vision === false && Boolean(model.image_refused_reason);
          return (
            <tr key={model.id}>
              <td className="py-1.5 font-mono text-xs text-text">
                <div>{model.name}</div>
                {marked && (
                  <div className="mt-1 font-sans text-xs text-text-secondary normal-case tracking-normal">
                    <span className="text-warning">{PROVIDER_MODEL_NO_IMAGES}</span>
                    {model.image_refused_reason && (
                      <span className="block text-text-tertiary mt-0.5">{model.image_refused_reason}</span>
                    )}
                  </div>
                )}
              </td>
              <td className="py-1.5">
                {model.vision !== false ? (
                  <span className="text-success">✓</span>
                ) : (
                  <span className="text-text-tertiary">—</span>
                )}
              </td>
              <td className="py-1.5 text-xs text-text-secondary">
                {SOURCE_LABELS[model.source] ?? model.source}
              </td>
              <td className="py-1.5 text-right">
                <div className="flex items-center justify-end gap-1 flex-wrap">
                  {marked && onRetryImages && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="!px-2 !py-1 min-w-0 text-text hover:bg-surface border border-border"
                      onClick={() => onRetryImages(model.id)}
                    >
                      {PROVIDER_MODEL_TRY_AGAIN}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Move up"
                    className="!px-2 !py-1 min-w-0 text-text hover:bg-surface border border-border"
                    onClick={() => onReorder(model.id, 'up')}
                    disabled={index === 0}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Move down"
                    className="!px-2 !py-1 min-w-0 text-text hover:bg-surface border border-border"
                    onClick={() => onReorder(model.id, 'down')}
                    disabled={index === models.length - 1}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={PROVIDER_REMOVE_MODEL}
                    className="!px-2 !py-1 min-w-0 text-error hover:bg-error hover:text-white border border-border"
                    onClick={() => onRemove(model.id)}
                  >
                    ×
                  </Button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
