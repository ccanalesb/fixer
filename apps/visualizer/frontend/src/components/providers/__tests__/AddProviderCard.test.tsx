import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddProviderCard } from '../AddProviderCard';

describe('AddProviderCard', () => {
  it('shows known-provider tiles on the known door', () => {
    render(<AddProviderCard onCreate={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Known providers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('known-provider-tiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ollama/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Manual' }));
    expect(screen.getByRole('tab', { name: 'Manual' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('known-provider-tiles')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/i)).toBeInTheDocument();
  });

  it('prefills from a known tile and submits', () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<AddProviderCard onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'OpenRouter',
        base_url: 'https://openrouter.ai/api/v1',
        auth: { mode: 'bearer', header_name: undefined, key: undefined },
        extra_headers: { 'HTTP-Referer': 'fixer', 'X-Title': 'Fixer' },
      }),
    );
  });
});
