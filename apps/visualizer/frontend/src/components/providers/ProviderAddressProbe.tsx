import type { Provider } from '../../services/api';

interface ProviderAddressProbeProps {
  probe: Provider['address_probe'];
}

export function ProviderAddressProbe({ probe }: ProviderAddressProbeProps) {
  if (!probe) {
    return <p className="text-sm text-text-tertiary">Connection not tested yet.</p>;
  }
  if (probe.answered) {
    return (
      <p className="text-sm text-success">
        Answered at{' '}
        <span className="font-mono text-xs break-all">{probe.url ?? 'unknown URL'}</span>
        {probe.probed_at ? (
          <span className="text-text-tertiary"> · {new Date(probe.probed_at).toLocaleString()}</span>
        ) : null}
      </p>
    );
  }
  return (
    <p className="text-sm text-error">
      No response
      {probe.error ? `: ${probe.error}` : ''}
      {probe.probed_at ? (
        <span className="text-text-tertiary"> · {new Date(probe.probed_at).toLocaleString()}</span>
      ) : null}
    </p>
  );
}
