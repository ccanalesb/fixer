import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '../../data';
import { ProvidersAPI, type ProviderModel } from '../../services/api';
import { ProviderCard, FallbackOrderPanel } from '../providers';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ProviderModelSelect } from '../ui/ProviderModelSelect';

export function ProvidersTab() {
  const [bundleRev, setBundleRev] = useState(0);
  const bundle = useQuery(
    ['providers.list', bundleRev] as const,
    async () => {
      const [providerList, fallback, defaults] = await Promise.all([
        ProvidersAPI.list(),
        ProvidersAPI.getFallbackOrder(),
        ProvidersAPI.getDefaults(),
      ]);
      return {
        providers: providerList,
        fallbackOrder: fallback.order,
        defaults,
      };
    },
  );

  const { providers, fallbackOrder } = bundle;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modelCache, setModelCache] = useState<Record<string, ProviderModel[]>>({});
  const [reachability, setReachability] = useState<Record<string, boolean | null>>({});
  const [connectionErrors, setConnectionErrors] = useState<Record<string, string | undefined>>({});
  const [descriptionProvider, setDescriptionProvider] = useState<string | null>(null);
  const [descriptionModel, setDescriptionModel] = useState<string | null>(null);
  const [defaultsSaveMsg, setDefaultsSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const block = bundle.defaults.description;
    if (block?.provider) {
      setDescriptionProvider(block.provider);
      setDescriptionModel(block.model ?? null);
    }
  }, [bundle.defaults]);

  const refreshModelsForProvider = useCallback(async (providerId: string) => {
    const models = await ProvidersAPI.listModels(providerId);
    setModelCache((previous) => ({ ...previous, [providerId]: models }));
  }, []);

  useEffect(() => {
    if (!expandedId || modelCache[expandedId]) return;
    refreshModelsForProvider(expandedId).catch(console.error);
  }, [expandedId, modelCache, refreshModelsForProvider]);

  useEffect(() => {
    if (providers.length === 0) return;
    let cancelled = false;
    Promise.all(
      providers.map((provider) =>
        ProvidersAPI.health(provider.id)
          .then((response) => ({
            id: provider.id,
            reachable: response.reachable,
            detail: response.reachable ? undefined : response.error,
          }))
          .catch((err) => ({
            id: provider.id,
            reachable: false,
            detail: err instanceof Error ? err.message : String(err),
          })),
      ),
    ).then((results) => {
      if (cancelled) return;
      setReachability((prev) => {
        const next = { ...prev };
        for (const row of results) {
          next[row.id] = row.reachable;
        }
        return next;
      });
      setConnectionErrors((prev) => {
        const next = { ...prev };
        for (const row of results) {
          if (row.detail) next[row.id] = row.detail;
          else delete next[row.id];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [providers]);

  const handleAddModel = useCallback(
    async (providerId: string, model: { id: string; name: string; vision: boolean }) => {
      await ProvidersAPI.addModel(providerId, model);
      await refreshModelsForProvider(providerId);
    },
    [refreshModelsForProvider],
  );

  const handleRemoveModel = useCallback(
    async (providerId: string, modelId: string) => {
      await ProvidersAPI.removeModel(providerId, modelId);
      await refreshModelsForProvider(providerId);
    },
    [refreshModelsForProvider],
  );

  const handleRetryModelImages = useCallback(
    async (providerId: string, modelId: string) => {
      await ProvidersAPI.retryModelImages(providerId, modelId);
      await refreshModelsForProvider(providerId);
    },
    [refreshModelsForProvider],
  );

  const handleReorderModel = useCallback(
    async (providerId: string, modelId: string, direction: 'up' | 'down') => {
      const models = modelCache[providerId] ?? [];
      const index = models.findIndex((m) => m.id === modelId);
      if (index === -1) return;

      const newModels = [...models];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= newModels.length) return;

      [newModels[index], newModels[targetIndex]] = [newModels[targetIndex], newModels[index]];
      const newOrder = newModels.map((m) => m.id);

      setModelCache((previous) => ({ ...previous, [providerId]: newModels }));

      try {
        await ProvidersAPI.reorderModels(providerId, newOrder);
      } catch {
        await refreshModelsForProvider(providerId);
      }
    },
    [modelCache, refreshModelsForProvider],
  );

  const updateFallbackOrder = useCallback(async (order: string[]) => {
    await ProvidersAPI.updateFallbackOrder(order);
    setBundleRev((n) => n + 1);
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-card-title text-text mb-2">AI Model Providers</h3>
        <p className="text-sm text-text-secondary">
          Configure vision model providers and manage fallback order
        </p>
      </div>

      <div className="space-y-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            models={modelCache[provider.id] ?? []}
            expanded={expandedId === provider.id}
            onToggle={() => setExpandedId((previous) => (previous === provider.id ? null : provider.id))}
            onAddModel={(model) => handleAddModel(provider.id, model)}
            onRemoveModel={(modelId) => {
              handleRemoveModel(provider.id, modelId).catch(console.error);
            }}
            onReorderModel={(modelId, direction) => {
              handleReorderModel(provider.id, modelId, direction).catch(console.error);
            }}
            onRetryModelImages={(modelId) => {
              handleRetryModelImages(provider.id, modelId).catch(console.error);
            }}
            connectionReachable={reachability[provider.id] ?? null}
            connectionError={connectionErrors[provider.id] ?? null}
          />
        ))}
      </div>

      <FallbackOrderPanel
        providers={providers}
        order={fallbackOrder}
        onReorder={(order) => {
          updateFallbackOrder(order).catch(console.error);
        }}
      />

      <Card padding="lg">
        <h4 className="text-base font-semibold text-text mb-1">Default models</h4>
        <p className="text-sm font-medium text-text mb-3">Descriptions</p>
        <ProviderModelSelect
          providerId={descriptionProvider}
          modelId={descriptionModel}
          onChange={(providerId, modelId) => {
            setDescriptionProvider(providerId);
            setDescriptionModel(modelId);
          }}
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!descriptionProvider}
            onClick={() => {
              if (!descriptionProvider) return;
              ProvidersAPI.updateDefaults({
                description: {
                  provider: descriptionProvider,
                  model: descriptionModel,
                },
              })
                .then(() => {
                  setDefaultsSaveMsg('Saved');
                  window.setTimeout(() => setDefaultsSaveMsg(null), 2000);
                  setBundleRev((n) => n + 1);
                })
                .catch(console.error);
            }}
          >
            Save
          </Button>
          {defaultsSaveMsg ? (
            <span className="text-sm text-success" role="status">
              {defaultsSaveMsg}
            </span>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
