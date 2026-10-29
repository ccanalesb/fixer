import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderCard } from '../ProviderCard';
import type { Job, Provider, ProviderModel } from '../../../services/api';

const baseProvider: Provider = {
  id: 'local',
  name: 'Local',
  protocol: 'openai',
  available: true,
  enabled: true,
  tool_calling: false,
  base_url: { from: 'literal', value: 'http://localhost/v1' },
  auth: { mode: 'none', has_key: false },
  address_probe: null,
};

const models: ProviderModel[] = [
  { id: 'm1', name: 'Model One', source: 'config', vision: true },
];

const activeJob: Job = {
  id: 'j1',
  type: 'batch_describe',
  status: 'running',
  progress: 10,
  logs: [],
  logs_total: 0,
  warning_count: 0,
  error_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  metadata: { provider_id: 'local' },
};

function renderCard(over: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
  const onSetEnabled = vi.fn().mockResolvedValue(undefined);
  const onRequestRemove = vi.fn();
  render(
    <ProviderCard
      provider={baseProvider}
      models={models}
      providers={[baseProvider, { ...baseProvider, id: 'cloud', name: 'Cloud', protocol: 'openai' }]}
      fallbackOrder={['local', 'cloud']}
      modelCache={{
        local: models,
        cloud: [{ id: 'm2', name: 'Cloud model', source: 'config', vision: true }],
      }}
      activeJobs={[activeJob]}
      expanded={false}
      onToggle={() => {}}
      onAddModel={async () => {}}
      onRemoveModel={() => {}}
      onReorderModel={() => {}}
      onSaveProvider={async () => {}}
      onTestConnection={async () => {}}
      onSetEnabled={onSetEnabled}
      onRequestRemove={onRequestRemove}
      {...over}
    />,
  );
  return { onSetEnabled, onRequestRemove };
}

describe('ProviderCard park and remove', () => {
  it('calls the API hook when the use switch is turned off', () => {
    const { onSetEnabled } = renderCard();
    const toggle = screen.getByRole('checkbox', { name: /use this provider/i });
    fireEvent.click(toggle);
    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });

  it('shows a note when a running job names this provider', () => {
    renderCard();
    expect(screen.getByRole('status')).toHaveTextContent(/1 running job continues on Cloud/i);
  });

  it('opens remove from the menu', () => {
    const { onRequestRemove } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /provider actions/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(onRequestRemove).toHaveBeenCalled();
  });
});

describe('ProviderRemoveConfirm', () => {
  it('lists jobs, the default, and models', async () => {
    const { ProviderRemoveConfirm } = await import('../ProviderRemoveConfirm');
    render(
      <ProviderRemoveConfirm
        provider={baseProvider}
        models={models}
        activeJobs={[activeJob, { ...activeJob, id: 'j2', status: 'pending' }]}
        isDescriptionDefault
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(/running or queued job/i);
    expect(screen.getByRole('dialog')).toHaveTextContent(/description default/i);
    expect(screen.getByRole('dialog')).toHaveTextContent(/Model One/i);
    expect(screen.getByRole('dialog')).toHaveTextContent(/switch/i);
  });
});
