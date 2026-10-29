import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Provider } from '../../../services/api';
import { ProviderEditForm } from '../ProviderEditForm';

const baseProvider: Provider = {
  id: 'edge',
  name: 'Edge',
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
});
