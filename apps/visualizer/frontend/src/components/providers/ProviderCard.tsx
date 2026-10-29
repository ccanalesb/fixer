import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job, Provider, ProviderModel } from '../../services/api';
import {
  PROVIDER_STATUS_AVAILABLE,
  PROVIDER_STATUS_UNAVAILABLE,
  PROVIDER_MODELS_HEADING,
  PROVIDER_NO_MODELS,
  PROVIDER_PARK_SWITCH_LABEL,
  PROVIDER_MENU_LABEL,
  PROVIDER_REMOVE_ACTION,
  PROVIDER_JOB_NOTE_RUNNING,
  PROVIDER_JOB_NOTE_QUEUED,
  PROVIDERS_SYSTEM_ONE_UNUSED,
  PROVIDERS_SYSTEM_ONE_USED_BY,
} from '../../constants/strings';
import { Badge } from '../ui/badges';
import { ModelList } from './ModelList';
import { AddModelForm } from './AddModelForm';
import { ProviderEditForm, type ProviderEditValues } from './ProviderEditForm';
import { ProviderAddressProbe } from './ProviderAddressProbe';
import { jobsUsingProvider } from './ProviderRemoveConfirm';
import { nextPhotoProvider } from './providerUsability';

interface ProviderCardProps {
  provider: Provider;
  models: ProviderModel[];
  providers: Provider[];
  fallbackOrder: string[];
  modelCache: Record<string, ProviderModel[]>;
  activeJobs: Job[];
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
  onSetEnabled: (enabled: boolean) => Promise<void>;
  onRequestRemove: () => void;
  testingConnection?: boolean;
  addressChangeImpact?: { photos: number; stageNames: string[] } | null;
  onBaseUrlChange?: (url: string) => void;
}

export function ProviderCard({
  provider,
  models,
  providers,
  fallbackOrder,
  modelCache,
  activeJobs,
  expanded,
  onToggle,
  onAddModel,
  onRemoveModel,
  onReorderModel,
  onRetryModelImages,
  onSaveProvider,
  onTestConnection,
  onSetEnabled,
  onRequestRemove,
  testingConnection = false,
  cullingStageNames,
  addressChangeImpact = null,
  onBaseUrlChange,
}: ProviderCardProps) {
  const probeAnswered = provider.address_probe?.answered;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const jobNote = useCallback((): string | null => {
    const using = jobsUsingProvider(activeJobs, provider.id);
    if (using.length === 0) return null;
    const next = nextPhotoProvider(providers, fallbackOrder, modelCache, provider.id);
    if (!next) return null;
    const running = using.filter(j => j.status === 'running').length;
    const queued = using.filter(j => j.status === 'pending').length;
    const parts: string[] = [];
    if (running > 0) parts.push(PROVIDER_JOB_NOTE_RUNNING(running, next.name));
    if (queued > 0) parts.push(PROVIDER_JOB_NOTE_QUEUED(queued, next.name));
    return parts.join('. ');
  }, [activeJobs, provider.id, providers, fallbackOrder, modelCache]);

  const note = jobNote();
  const systemOneUsage =
    provider.protocol === 'system_one'
      ? cullingStageNames && cullingStageNames.length > 0
        ? PROVIDERS_SYSTEM_ONE_USED_BY(cullingStageNames.join(' and '))
        : PROVIDERS_SYSTEM_ONE_UNUSED
      : null;

  return (
    <div className="rounded-card border border-border bg-bg shadow-card">
      <div className="px-4 py-3 flex items-start gap-3 border-b border-border sm:border-0">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 min-w-0 flex items-center justify-between text-left rounded-t-card hover:opacity-90 transition-opacity"
        >
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
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
              {!provider.enabled ? <Badge variant="warning">Not in use</Badge> : null}
            </div>
            {systemOneUsage ? (
              <p className="text-xs text-text-secondary truncate">{systemOneUsage}</p>
            ) : null}
          </div>
          <span className="text-text-tertiary text-sm shrink-0 ml-2">{expanded ? '▲' : '▼'}</span>
        </button>

        <label className="flex items-center gap-2 shrink-0 text-sm text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={provider.enabled}
            aria-label={PROVIDER_PARK_SWITCH_LABEL}
            onChange={event => {
              void onSetEnabled(event.target.checked);
            }}
            onClick={event => event.stopPropagation()}
          />
          <span className="hidden sm:inline">{PROVIDER_PARK_SWITCH_LABEL}</span>
        </label>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-label={PROVIDER_MENU_LABEL}
            className="px-2 py-1 rounded-base border border-border text-text-secondary hover:bg-surface text-lg leading-none"
            onClick={() => setMenuOpen(open => !open)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="absolute right-0 top-full mt-1 z-10 min-w-[10rem] rounded-base border border-border bg-bg shadow-card py-1">
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm text-error hover:bg-surface"
                onClick={() => {
                  setMenuOpen(false);
                  onRequestRemove();
                }}
              >
                {PROVIDER_REMOVE_ACTION}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {note ? (
        <p className="px-4 pb-2 text-sm text-text-secondary" role="status">
          {note}
        </p>
      ) : null}

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
