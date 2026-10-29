import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddSystemOneProviderCard } from '../AddSystemOneProviderCard';

describe('AddSystemOneProviderCard', () => {
  it('submits name, URL, key and comma-separated model ids', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<AddSystemOneProviderCard onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText(/^Name$/i), { target: { value: 'Studio GPU' } });
    fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'http://studio:8000' } });
    fireEvent.change(screen.getByLabelText(/API key/i), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText(/^Models$/i), { target: { value: 'clef-flash, jev-omni-3b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Studio GPU',
      base_url: 'http://studio:8000',
      protocol: 'system_one',
      models: ['clef-flash', 'jev-omni-3b'],
      auth: { mode: 'bearer', key: 'secret' },
    });
  });
});
