import { useMemo, useState, type FormEvent } from 'react';
import type { Provider } from '../../services/api';
import { Button } from '../ui/Button';

function hostKey(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const inputClassName =
  'w-full border border-border rounded-base px-2 py-1.5 text-sm bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1';

export interface ProviderEditValues {
  name: string;
  base_url: string;
  auth_mode: 'none' | 'bearer' | 'header';
  header_name: string;
  key: string;
}

interface ProviderEditFormProps {
  provider: Provider;
  onSave: (values: ProviderEditValues) => Promise<void>;
  onTestConnection: () => Promise<void>;
  testing?: boolean;
}

export function ProviderEditForm({
  provider,
  onSave,
  onTestConnection,
  testing = false,
}: ProviderEditFormProps) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.base_url.value);
  const [authMode, setAuthMode] = useState(provider.auth.mode);
  const [headerName, setHeaderName] = useState(provider.auth.header_name ?? '');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hostWillClearKey = useMemo(() => {
    const prev = hostKey(provider.base_url.value);
    const next = hostKey(baseUrl);
    return prev !== null && next !== null && prev !== next;
  }, [provider.base_url.value, baseUrl]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        base_url: baseUrl.trim(),
        auth_mode: authMode,
        header_name: headerName.trim(),
        key: key.trim(),
      });
      setKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={event => handleSubmit(event).catch(console.error)}
      className="space-y-3 mb-4 pb-4 border-b border-border"
    >
      {error ? (
        <p className="text-sm text-error" role="alert">
          {error}
        </p>
      ) : null}
      {hostWillClearKey ? (
        <p className="text-sm text-warning" role="status">
          Changing the host clears the saved API key. Enter a new key before saving if you still need
          one.
        </p>
      ) : null}
      <label className="block text-xs text-text-secondary">
        <span className="block mb-0.5">Name</span>
        <input
          type="text"
          value={name}
          onChange={event => setName(event.target.value)}
          className={inputClassName}
          disabled={saving}
        />
      </label>
      <label className="block text-xs text-text-secondary">
        <span className="block mb-0.5">Base URL</span>
        <input
          type="url"
          value={baseUrl}
          onChange={event => setBaseUrl(event.target.value)}
          className={`${inputClassName} font-mono`}
          disabled={saving}
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-text-secondary">
          <span className="block mb-0.5">Auth</span>
          <select
            value={authMode}
            onChange={event => setAuthMode(event.target.value as ProviderEditValues['auth_mode'])}
            className={inputClassName}
            disabled={saving}
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
              disabled={saving}
            />
          </label>
        ) : null}
      </div>
      {authMode !== 'none' ? (
        <div className="space-y-1">
          {provider.auth.secret_from === 'env' && provider.auth.env_var ? (
            <p className="text-xs text-text-secondary">
              Key from variable{' '}
              <code className="font-mono">{provider.auth.env_var}</code>
              {' · '}
              {provider.auth.env_set ? 'set' : 'not set'}
            </p>
          ) : provider.auth.has_key ? (
            <p className="text-xs text-text-secondary">A key is saved. Type below to replace it.</p>
          ) : (
            <p className="text-xs text-text-secondary">No key saved.</p>
          )}
          <label className="block text-xs text-text-secondary">
            <span className="block mb-0.5">API key</span>
            <input
              type="password"
              value={key}
              onChange={event => setKey(event.target.value)}
              className={inputClassName}
              autoComplete="off"
              disabled={saving}
            />
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save provider'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testing || saving}
          onClick={() => onTestConnection().catch(console.error)}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
    </form>
  );
}
