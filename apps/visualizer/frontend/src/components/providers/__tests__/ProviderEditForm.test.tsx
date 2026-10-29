import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../../services/api';
import { ProviderEditForm } from '../ProviderEditForm';

const baseProvider: Provider = {
  id: 'edge',
  name: 'Edge',
  protocol: 'openai',
  available: true,
  tool_calling: false,
  enabled: true,
  base_url: { from: 'literal', value: 'https://alpha.example/v1' },
  auth: { mode: 'bearer', has_key: true, secret_from: 'literal' },
  address_probe: null,
};

describe('ProviderEditForm', () => {
  it('warns before save when the host changes', () => {
    render(
      <ProviderEditForm
        provider={baseProvider}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Base URL/i), {
      target: { value: 'https://beta.example/v1' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/host clears the saved API key/i);
  });

  it('warns when a System One address change will re-answer photos', () => {
    const systemOne: Provider = {
      ...baseProvider,
      id: 'studio',
      protocol: 'system_one',
      base_url: { from: 'literal', value: 'http://studio:8000' },
    };
    render(
      <ProviderEditForm
        provider={systemOne}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
        addressChangeImpact={{ photos: 42, stageNames: ['Culling profile'] }}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Base URL/i), {
      target: { value: 'http://studio:9000' },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/42 photo/);
    expect(screen.getByRole('status')).toHaveTextContent(/Culling profile/);
  });
});
