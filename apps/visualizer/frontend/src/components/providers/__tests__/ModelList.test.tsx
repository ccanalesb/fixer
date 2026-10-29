import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelList } from '../ModelList';
import { PROVIDER_MODEL_NO_IMAGES, PROVIDER_MODEL_TRY_AGAIN } from '../../../constants/strings';

describe('ModelList', () => {
  it('shows an image-refusal mark with reason and Try again', () => {
    const onRetry = vi.fn();
    render(
      <ModelList
        models={[
          {
            id: 'm1',
            name: 'Vision',
            source: 'user',
            vision: true,
          },
          {
            id: 'm2',
            name: 'Texty',
            source: 'config',
            vision: false,
            image_refused_reason: 'Server does not accept image_url parts',
          },
        ]}
        onRemove={() => {}}
        onReorder={() => {}}
        onRetryImages={onRetry}
      />,
    );

    expect(screen.getByText(PROVIDER_MODEL_NO_IMAGES)).toBeInTheDocument();
    expect(screen.getByText('Server does not accept image_url parts')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: PROVIDER_MODEL_TRY_AGAIN }));
    expect(onRetry).toHaveBeenCalledWith('m2');
  });
});
