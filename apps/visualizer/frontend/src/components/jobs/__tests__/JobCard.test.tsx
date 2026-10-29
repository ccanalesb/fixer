import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JobCard } from '../JobCard';
import type { Job } from '../../../types/job';
import { JOB_TEST_DEFAULTS } from '../../../types/jobTestDefaults';

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-clip-dl',
    type: 'batch_embed_image',
    status: 'running',
    progress: 35,
    current_step: 'Downloading the image model (once) — 80 / 352 MB',
    logs: [],
    logs_total: 0,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    metadata: {
      clip_model_download_loaded_bytes: 80_000_000,
      clip_model_download_total_bytes: 351_685_709,
    },
    clip_model_download_loaded_bytes: 80_000_000,
    clip_model_download_total_bytes: 351_685_709,
    ...JOB_TEST_DEFAULTS,
    ...overrides,
  } as Job;
}

describe('JobCard', () => {
  it('shows the CLIP download step while the model is streaming', () => {
    render(<JobCard job={makeJob({})} />);
    expect(
      screen.getByText('Downloading the image model (once) — 80 / 352 MB'),
    ).toBeTruthy();
    expect(screen.getByText('35%')).toBeTruthy();
  });
});
