import { useEffect, useState } from 'react';
import { getAppPort, isTauriDesktop, setAppPort } from '../../lib/tauriHost';
import { Button } from '../ui/Button/Button';
import { Input } from '../ui/Input/Input';
import { SettingRow } from './SettingRow';

export function AppPortSettingRow() {
  const [port, setPort] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isTauriDesktop()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const value = await getAppPort();
        if (!cancelled) {
          const text = String(value);
          setPort(text);
          setDraft(text);
        }
      } catch {
        if (!cancelled) {
          setError('Could not read the local port.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isTauriDesktop()) {
    return null;
  }

  if (loading) {
    return (
      <SettingRow
        name="Local port"
        description="Loading…"
        control={null}
      />
    );
  }

  const changed = draft !== port;

  const save = async () => {
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      setError('Enter a port between 1 and 65535.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setAppPort(parsed);
      setPort(String(parsed));
      setSaved(true);
    } catch {
      setError('Could not save the port.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      name="Local port"
      description={
        error ? (
          <span className="text-error">{error}</span>
        ) : saved && !changed ? (
          <span className="text-text-secondary">Saved. Restart Fixer for this port to take effect.</span>
        ) : (
          <span className="text-text-secondary">
            Loopback port for the bundled backend. Changes apply after you restart the app.
          </span>
        )
      }
      control={
        <>
          <Input
            type="number"
            min={1}
            max={65535}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSaved(false);
            }}
            className="w-24"
            aria-label="Local port"
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={save}
            disabled={saving || !changed}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    />
  );
}
