import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '../../data';
import {
  CullingModelsAPI,
  ProvidersAPI,
  type ProviderModel,
} from '../../services/api';
import {
  FallbackOrderPanel,
  OpenAiProvidersGroup,
  SystemOneProvidersGroup,
  type CreateProviderPayload,
} from '../providers';
import type { CreateSystemOneProviderPayload } from '../providers/AddSystemOneProviderCard';
import type { ProviderEditValues } from '../providers/ProviderEditForm';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ProviderModelSelect } from '../ui/ProviderModelSelect';

export function ProvidersTab() {
  const [bundleRev, setBundleRev] = useState(0);
  const bundle = useQuery(
    ['providers.list', bundleRev] as const,
    async () => {
      const [providerList, fallback, defaults, cullingModels] = await Promise.all([
        ProvidersAPI.list(),
        ProvidersAPI.getFallbackOrder(),
        ProvidersAPI.getDefaults(),
        CullingModelsAPI.get().catch(() => null),
      ]);
      return {
        providers: providerList,
        fallbackOrder: fallback.order,
        defaults,
        cullingModels,
      };
    },
  );

  const { providers, fallbackOrder } = bundle;
  const openAiProviders = useMemo(
    () => providers.filter(p => p.protocol !== 'system_one'),
    [providers],
  );
  const systemOneProviders = useMemo(
    () => providers.filter(p => p.protocol === 'system_one'),
    [providers],
  );

  const cullingStagesByProvider = useMemo(() => {
    const map: Record<string, string[]> = {};
    const cm = bundle.cullingModels;
    if (!cm) return map;
    const add = (providerId: string, label: string) => {
      if (!providerId || providerId === 'this_app') return;
      map[providerId] = [...(map[providerId] ?? []), label];
    };
    if (cm.culling_profile.endpoint !== 'this_app') {
      add(cm.culling_profile.endpoint, 'Culling profile');
    }
    if (cm.score_forecast.endpoint !== 'this_app') {
      add(cm.score_forecast.endpoint, 'Score forecast');
    }
    return map;
  }, [bundle.cullingModels]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modelCache, setModelCache] = useState<Record<string, ProviderModel[]>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [descriptionProvider, setDescriptionProvider] = useState<string | null>(null);
  const [descriptionModel, setDescriptionModel] = useState<string | null>(null);
  const [defaultsSaveMsg, setDefaultsSaveMsg] = useState<string | null>(null);
  const [addressImpactByProvider, setAddressImpactByProvider] = useState<
    Record<string, { photos: number; stageNames: string[] } | null>
  >({});

  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#system-one-providers') {
      document.getElementById('system-one-providers')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [hash, bundleRev]);

  useEffect(() => {
    const block = bundle.defaults.description;
    if (block?.provider) {
      setDescriptionProvider(block.provider);
      setDescriptionModel(block.model ?? null);
    }
  }, [bundle.defaults]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, { photos: number; stageNames: string[] } | null> = {};
      await Promise.all(
        systemOneProviders.map(async p => {
          try {
            const impact = await ProvidersAPI.addressChangeImpact(p.id);
            next[p.id] = {
              photos: impact.photos,
              stageNames: impact.stages.map(s => s.name),
            };
          } catch {
            next[p.id] = null;
          }
        }),
      );
      if (!cancelled) setAddressImpactByProvider(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [systemOneProviders, bundleRev]);

  const refreshBundle = useCallback(() => {
    setBundleRev(n => n + 1);
  }, []);

  const refreshModelsForProvider = useCallback(async (providerId: string) => {
    const models = await ProvidersAPI.listModels(providerId);
    setModelCache(previous => ({ ...previous, [providerId]: models }));
  }, []);

  useEffect(() => {
    if (!expandedId || modelCache[expandedId]) return;
    refreshModelsForProvider(expandedId).catch(console.error);
  }, [expandedId, modelCache, refreshModelsForProvider]);

  const handleCreateOpenAi = useCallback(
    async (payload: CreateProviderPayload) => {
      const created = await ProvidersAPI.create(payload);
      refreshBundle();
      setExpandedId(created.id);
      await refreshModelsForProvider(created.id);
    },
    [refreshBundle, refreshModelsForProvider],
  );

  const handleCreateSystemOne = useCallback(
    async (payload: CreateSystemOneProviderPayload) => {
      const created = await ProvidersAPI.create(payload);
      refreshBundle();
      setExpandedId(created.id);
      await refreshModelsForProvider(created.id);
    },
    [refreshBundle, refreshModelsForProvider],
  );

  const handleSaveProvider = useCallback(
    async (providerId: string, values: ProviderEditValues) => {
      await ProvidersAPI.update(providerId, {
        name: values.name,
        base_url: values.base_url,
        auth: {
          mode: values.auth_mode,
          header_name: values.auth_mode === 'header' ? values.header_name : undefined,
          key: values.key || undefined,
        },
      });
      refreshBundle();
    },
    [refreshBundle],
  );

  const handleTestConnection = useCallback(
    async (providerId: string) => {
      setTestingId(providerId);
      try {
        await ProvidersAPI.probe(providerId);
        refreshBundle();
      } finally {
        setTestingId(null);
      }
    },
    [refreshBundle],
  );

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
      const index = models.findIndex(m => m.id === modelId);
      if (index === -1) return;

      const newModels = [...models];
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= newModels.length) return;

      [newModels[index], newModels[targetIndex]] = [newModels[targetIndex], newModels[index]];
      const newOrder = newModels.map(m => m.id);

      setModelCache(previous => ({ ...previous, [providerId]: newModels }));

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
    refreshBundle();
  }, [refreshBundle]);

  const handleBaseUrlChange = useCallback((_providerId: string, _url: string) => {
    // Impact counts depend on library answers, not the draft URL; loaded once per provider.
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-card-title text-text mb-2">AI Model Providers</h3>
        <p className="text-sm text-text-secondary">
          OpenAI-compatible servers for descriptions and scoring; System One endpoints for culling stages
        </p>
      </div>

      <OpenAiProvidersGroup
        providers={openAiProviders}
        expandedId={expandedId}
        modelCache={modelCache}
        testingId={testingId}
        onToggle={id => setExpandedId(previous => (previous === id ? null : id))}
        onCreate={handleCreateOpenAi}
        onSaveProvider={handleSaveProvider}
        onTestConnection={handleTestConnection}
        onAddModel={handleAddModel}
        onRemoveModel={(providerId, modelId) => {
          handleRemoveModel(providerId, modelId).catch(console.error);
        }}
        onReorderModel={(providerId, modelId, direction) => {
          handleReorderModel(providerId, modelId, direction).catch(console.error);
        }}
        onRetryModelImages={(providerId, modelId) => {
          handleRetryModelImages(providerId, modelId).catch(console.error);
        }}
      />

      <SystemOneProvidersGroup
        providers={systemOneProviders}
        cullingStagesByProvider={cullingStagesByProvider}
        expandedId={expandedId}
        modelCache={modelCache}
        testingId={testingId}
        addressImpactByProvider={addressImpactByProvider}
        onToggle={id => setExpandedId(previous => (previous === id ? null : id))}
        onCreate={handleCreateSystemOne}
        onSaveProvider={handleSaveProvider}
        onTestConnection={handleTestConnection}
        onAddModel={handleAddModel}
        onRemoveModel={(providerId, modelId) => {
          handleRemoveModel(providerId, modelId).catch(console.error);
        }}
        onReorderModel={(providerId, modelId, direction) => {
          handleReorderModel(providerId, modelId, direction).catch(console.error);
        }}
        onBaseUrlChange={handleBaseUrlChange}
      />

      <FallbackOrderPanel
        providers={openAiProviders}
        order={fallbackOrder}
        onReorder={order => {
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
                  refreshBundle();
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
