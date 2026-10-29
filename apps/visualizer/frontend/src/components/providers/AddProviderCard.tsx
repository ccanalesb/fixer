import { useState, type FormEvent } from 'react';
import { KNOWN_PROVIDER_PRESETS, type KnownProviderPreset } from './known-providers';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

type Door = 'known' | 'manual';

const inputClassName =
  'w-full border border-border rounded-base px-2 py-1.5 text-sm bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1';

export interface CreateProviderPayload {
  name: string;
  base_url: string;
  auth: { mode: 'none' | 'bearer' | 'header'; header_name?: string; key?: string };
  extra_headers?: Record<string, string>;
}

interface AddProviderCardProps {
  onCreate: (payload: CreateProviderPayload) => Promise<void>;
}

export function AddProviderCard({ onCreate }: AddProviderCardProps) {
  const [door, setDoor] = useState<Door>('known');
  const [selectedPreset, setSelectedPreset] = useState<KnownProviderPreset | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'bearer' | 'header'>('none');
  const [headerName, setHeaderName] = useState('');
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyPreset(preset: KnownProviderPreset) {
    setSelectedPreset(preset);
    setName(preset.label);
    setBaseUrl(preset.baseUrl);
    setAuthMode(preset.authMode);
    setKey('');
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedBase = baseUrl.trim();
    if (!trimmedName || !trimmedBase || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const preset = door === 'known' ? selectedPreset : null;
      await onCreate({
        name: trimmedName,
        base_url: trimmedBase,
        auth: {
          mode: authMode,
          header_name: authMode === 'header' ? headerName.trim() || undefined : undefined,
          key: authMode !== 'none' && key.trim() ? key.trim() : undefined,
        },
        extra_headers: preset?.extraHeaders,
      });
      setName('');
      setBaseUrl('');
      setKey('');
      setSelectedPreset(null);
      setAuthMode('none');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card padding="lg">
      <h4 className="text-base font-semibold text-text mb-1">Add a provider</h4>
      <p className="text-sm text-text-secondary mb-4">
        Connect an OpenAI-compatible model server by choosing a preset or entering details manually.
      </p>
      <div
        className="inline-flex p-0.5 mb-4 rounded-base border border-border bg-surface"
        role="tablist"
        aria-label="Add provider method"
      >
        <button
          type="button"
          role="tab"
          aria-selected={door === 'known'}
          className={`px-3 py-1.5 text-sm font-medium rounded-base transition-colors ${
            door === 'known' ? 'bg-bg text-text shadow-sm' : 'text-text-secondary'
          }`}
          onClick={() => setDoor('known')}
        >
          Known providers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={door === 'manual'}
          className={`px-3 py-1.5 text-sm font-medium rounded-base transition-colors ${
            door === 'manual' ? 'bg-bg text-text shadow-sm' : 'text-text-secondary'
          }`}
          onClick={() => setDoor('manual')}
        >
          Manual
        </button>
      </div>

      {door === 'known' ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" data-testid="known-provider-tiles">
          {KNOWN_PROVIDER_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className={`text-left p-2.5 rounded-base border text-sm transition-colors ${
                selectedPreset?.id === preset.id
                  ? 'border-accent ring-2 ring-accent/30 bg-accent-light/30'
                  : 'border-border hover:bg-surface'
              }`}
              onClick={() => applyPreset(preset)}
            >
              <span className="font-semibold text-text block">{preset.label}</span>
              <span className="text-xs text-text-tertiary block mt-0.5 truncate">{preset.baseUrl}</span>
            </button>
          ))}
        </div>
      ) : null}

      <form onSubmit={event => handleSubmit(event).catch(console.error)} className="space-y-3">
        {error ? (
          <p className="text-sm text-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="block text-xs text-text-secondary">
          <span className="block mb-0.5">Name</span>
          <input
            type="text"
            value={name}
            onChange={event => setName(event.target.value)}
            className={inputClassName}
            disabled={submitting || (door === 'known' && !selectedPreset && !name)}
          />
        </label>
        {door === 'manual' ? (
          <>
            <label className="block text-xs text-text-secondary">
              <span className="block mb-0.5">Base URL</span>
              <input
                type="url"
                value={baseUrl}
                onChange={event => setBaseUrl(event.target.value)}
                className={`${inputClassName} font-mono`}
                disabled={submitting}
              />
            </label>
            <label className="block text-xs text-text-secondary">
              <span className="block mb-0.5">Auth</span>
              <select
                value={authMode}
                onChange={event =>
                  setAuthMode(event.target.value as 'none' | 'bearer' | 'header')
                }
                className={inputClassName}
                disabled={submitting}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </select>
            </label>
            {authMode === 'header' ? (
              <label className="block text-xs text-text-secondary">
                <span className="block mb-0.5">Header name</span>
                <input
                  type="text"
                  value={headerName}
                  onChange={event => setHeaderName(event.target.value)}
                  className={inputClassName}
                  disabled={submitting}
                />
              </label>
            ) : null}
          </>
        ) : selectedPreset ? (
          <p className="text-sm text-text-secondary font-mono break-all">{baseUrl}</p>
        ) : (
          <p className="text-sm text-text-tertiary">Pick a tile above to continue.</p>
        )}
        {(door === 'manual' ? authMode !== 'none' : selectedPreset?.authMode === 'bearer') ? (
          <label className="block text-xs text-text-secondary">
            <span className="block mb-0.5">API key</span>
            <input
              type="password"
              value={key}
              onChange={event => setKey(event.target.value)}
              className={inputClassName}
              autoComplete="off"
              disabled={submitting}
            />
          </label>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={
            submitting ||
            !name.trim() ||
            !baseUrl.trim() ||
            (door === 'known' && !selectedPreset)
          }
        >
          {submitting ? 'Adding…' : 'Add provider'}
        </Button>
      </form>
    </Card>
  );
}
