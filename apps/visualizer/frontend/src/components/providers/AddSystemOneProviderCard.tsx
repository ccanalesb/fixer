import { useState, type FormEvent } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import {
  PROVIDERS_ADD_SYSTEM_ONE,
  PROVIDERS_SYSTEM_ONE_MODELS_HINT,
  PROVIDERS_SYSTEM_ONE_MODELS_LABEL,
} from '../../constants/strings';

const inputClassName =
  'w-full border border-border rounded-base px-2 py-1.5 text-sm bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1';

export interface CreateSystemOneProviderPayload {
  name: string;
  base_url: string;
  auth: { mode: 'bearer'; key?: string };
  protocol: 'system_one';
  models: string[];
}

interface AddSystemOneProviderCardProps {
  compact?: boolean;
  onCreate: (payload: CreateSystemOneProviderPayload) => Promise<void>;
}

function parseModelIds(raw: string): string[] {
  return [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
}

export function AddSystemOneProviderCard({ compact = false, onCreate }: AddSystemOneProviderCardProps) {
  const [open, setOpen] = useState(!compact);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedBase = baseUrl.trim();
    const modelIds = parseModelIds(models);
    if (!trimmedName || !trimmedBase || modelIds.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: trimmedName,
        base_url: trimmedBase,
        protocol: 'system_one',
        models: modelIds,
        auth: { mode: 'bearer', key: key.trim() || undefined },
      });
      setName('');
      setBaseUrl('');
      setKey('');
      setModels('');
      if (compact) setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const form = (
    <form
      onSubmit={event => handleSubmit(event).catch(console.error)}
      className="space-y-3 border border-dashed border-border-strong rounded-base p-3"
    >
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
          disabled={submitting}
        />
      </label>
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
      <label className="block text-xs text-text-secondary">
        <span className="block mb-0.5">{PROVIDERS_SYSTEM_ONE_MODELS_LABEL}</span>
        <input
          type="text"
          value={models}
          onChange={event => setModels(event.target.value)}
          placeholder={PROVIDERS_SYSTEM_ONE_MODELS_HINT}
          className={inputClassName}
          disabled={submitting}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-xs text-text-tertiary">Saving checks GET /v1/models.</span>
        {compact ? (
          <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );

  if (compact && !open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {PROVIDERS_ADD_SYSTEM_ONE}
      </Button>
    );
  }

  if (compact) {
    return form;
  }

  return (
    <Card padding="lg">
      <h4 className="text-base font-semibold text-text mb-1">{PROVIDERS_ADD_SYSTEM_ONE}</h4>
      {form}
    </Card>
  );
}
