import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '../../data';
import {
  CullingModelsAPI,
  JobsAPI,
  ProvidersAPI,
  type ProviderModel,
} from '../../services/api';
import {
  OpenAiProvidersGroup,
  SystemOneProvidersGroup,
  ProviderRemoveConfirm,
  TaskAssignmentsBlock,
  type CreateProviderPayload,
} from '../providers';
import type { CreateSystemOneProviderPayload } from '../providers/AddSystemOneProviderCard';
import type { ProviderEditValues } from '../providers/ProviderEditForm';
import { THIS_APP_SECTION_ID } from '../../constants/strings';

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

  const activeJobs = useQuery(['jobs.active'] as const, () => JobsAPI.getActive(), {
    initialValue: [],
  });

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

  const thisAppTaskUsage = useMemo(() => {
    const cm = bundle.cullingModels;
    if (!cm) return { cullingProfile: false, scoreForecast: false };
    return {
      cullingProfile: cm.culling_profile.endpoint === 'this_app',
      scoreForecast: cm.score_forecast.endpoint === 'this_app',
    };
  }, [bundle.cullingModels]);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modelCache, setModelCache] = useState<Record<string, ProviderModel[]>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [defaultsNotice, setDefaultsNotice] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [addressImpactByProvider, setAddressImpactByProvider] = useState<
    Record<string, { photos: number; stageNames: string[] } | null>
  >({});

  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#system-one-providers' || hash === `#${THIS_APP_SECTION_ID}`) {
      document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [hash, bundleRev]);

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

  useEffect(() => {
    for (const provider of providers) {
      if (modelCache[provider.id]) continue;
      ProvidersAPI.listModels(provider.id)
        .then(models => setModelCache(previous => ({ ...previous, [provider.id]: models })))
        .catch(console.error);
    }
  }, [providers, modelCache]);

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

  const handleSetEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      const result = await ProvidersAPI.update(providerId, { enabled });
      if (result.defaults_notice) setDefaultsNotice(result.defaults_notice);
      refreshBundle();
    },
    [refreshBundle],
  );

  const handleConfirmRemove = useCallback(async () => {
    if (!removeTargetId) return;
    setRemoveBusy(true);
    try {
      const result = await ProvidersAPI.remove(removeTargetId);
      if (result.defaults_notice) setDefaultsNotice(result.defaults_notice);
      setRemoveTargetId(null);
      if (expandedId === removeTargetId) setExpandedId(null);
      refreshBundle();
    } catch (e) {
      console.error(e);
    } finally {
      setRemoveBusy(false);
    }
  }, [removeTargetId, expandedId, refreshBundle]);

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

  const removeTarget = removeTargetId ? providers.find(p => p.id === removeTargetId) : null;

  const sharedCardContext = {
    allProviders: providers,
    fallbackOrder,
    modelCache,
    activeJobs,
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-card-title text-text mb-2">AI Model Providers</h3>
        <p className="text-sm text-text-secondary">
          Who answers each task, then the servers that provide those models
        </p>
      </div>

      <TaskAssignmentsBlock
        openAiProviders={openAiProviders}
        fallbackOrder={fallbackOrder}
        modelCache={modelCache}
        defaults={bundle.defaults}
        defaultsNotice={defaultsNotice}
        onRefreshBundle={refreshBundle}
      />

      <OpenAiProvidersGroup
        providers={openAiProviders}
        expandedId={expandedId}
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
        {...sharedCardContext}
        onSetEnabled={handleSetEnabled}
        onRequestRemove={setRemoveTargetId}
      />

      <SystemOneProvidersGroup
        providers={systemOneProviders}
        cullingStagesByProvider={cullingStagesByProvider}
        cullingProfileUsesThisApp={thisAppTaskUsage.cullingProfile}
        scoreForecastUsesThisApp={thisAppTaskUsage.scoreForecast}
        expandedId={expandedId}
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
        {...sharedCardContext}
        onSetEnabled={handleSetEnabled}
        onRequestRemove={setRemoveTargetId}
      />

      {removeTarget ? (
        <ProviderRemoveConfirm
          provider={removeTarget}
          models={modelCache[removeTarget.id] ?? []}
          activeJobs={activeJobs}
          isDescriptionDefault={bundle.defaults.description?.provider === removeTarget.id}
          cullingStageNames={cullingStagesByProvider[removeTarget.id]}
          onConfirm={() => {
            handleConfirmRemove().catch(console.error);
          }}
          onCancel={() => setRemoveTargetId(null)}
          busy={removeBusy}
        />
      ) : null}
    </div>
  );
}
