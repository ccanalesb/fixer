import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { deleteMatching } from '../../../data/cache';
import { AnalyzeTab } from '../AnalyzeTab';
import {
  ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT,
  ANALYZE_BACKFILL_VISUAL_TAGS_LABEL,
  ANALYZE_FORCE_CULL_HINT,
  ANALYZE_FORCE_DESCRIBE_LABEL,
  ANALYZE_FORCE_SCORE_LABEL,
} from '../../../constants/strings';

// Minimal AnalyzeOptions provider the component expects. We stub it directly
// rather than mounting the real provider so the test stays focused on the
// submit-feedback contract introduced in fix #1.
vi.mock('../../../stores/analyzeOptionsContext', () => ({
  useAnalyzeOptions: () => ({
    options: { maxWorkers: 4 },
    updateOption: vi.fn(),
  }),
}));

// Provider-select is unrelated to submission feedback — render a no-op.
vi.mock('../../ui/ProviderModelSelect', () => ({
  ProviderModelSelect: () => null,
}));
vi.mock('../../ui/WorkerSlider', () => ({
  WorkerSlider: () => null,
}));

const mockCreate = vi.fn();
const mockListPerspectives = vi.fn();
const mockGetDefaults = vi.fn();

vi.mock('../../../services/api', () => ({
  JobsAPI: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
  PerspectivesAPI: {
    list: (...args: unknown[]) => mockListPerspectives(...args),
  },
  ProvidersAPI: {
    getDefaults: (...args: unknown[]) => mockGetDefaults(...args),
  },
  CullingModelsAPI: {
    usable: () => {
      const ok = { on: true, problem: null, model: 'culling-model', endpoint: 'this_app', job_id: null, provider_name: null };
      return Promise.resolve({ culling_profile: ok, score_forecast: ok, culling_profile_filter: true });
    },
  },
}));

function renderAnalyzeTab() {
  return render(
    <Suspense fallback={null}>
      <AnalyzeTab />
    </Suspense>,
  );
}

describe('AnalyzeTab submit UX (fix #1)', () => {
  beforeEach(() => {
    deleteMatching(() => true);
    mockCreate.mockReset();
    mockListPerspectives.mockReset();
    mockGetDefaults.mockReset();
    mockListPerspectives.mockResolvedValue([
      { slug: 'street', display_name: 'Street' },
    ]);
    mockGetDefaults.mockResolvedValue({ description: { provider: 'ollama', model: 'llava' } });
  });

  it('shows an inline success banner (not an alert) after submission', async () => {
    mockCreate.mockResolvedValue({ id: 'abc12345-job', type: 'batch_analyze' });

    renderAnalyzeTab();

    // Wait for the mounted async effects (perspectives + provider defaults)
    // to settle so React doesn't complain about act() wrapping.
    await screen.findByText(/Street/);

    const primary = screen.getByRole('button', { name: /^Analyze/i });
    fireEvent.click(primary);

    const banner = await screen.findByTestId('analyze-status-banner');
    expect(banner.getAttribute('data-tone')).toBe('success');
    expect(banner.textContent).toMatch(/abc12345/);
  });

  it('shows an inline error banner when the POST fails', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));

    renderAnalyzeTab();
    await screen.findByText(/Street/);

    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }));

    const banner = await screen.findByTestId('analyze-status-banner');
    expect(banner.getAttribute('data-tone')).toBe('error');
    expect(banner.textContent).toMatch(/boom/);
  });

  it('only fires one POST even when the button is clicked three times rapidly', async () => {
    // Delay the resolution so the second and third clicks land while the
    // first is still in-flight. This is the real-world scenario the user
    // hit: a slow backend + no visual feedback + panicked re-clicks.
    let resolveCreate: (v: unknown) => void = () => {};
    mockCreate.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    renderAnalyzeTab();
    await screen.findByText(/Street/);

    const primary = screen.getByRole('button', { name: /^Analyze/i });
    fireEvent.click(primary);
    fireEvent.click(primary);
    fireEvent.click(primary);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    fireEvent.click(primary);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Resolving closes the submission so subsequent clicks work again.
    await act(async () => {
      resolveCreate({ id: 'first-job' });
    });
    await waitFor(() => expect(screen.getByTestId('analyze-status-banner')).toBeTruthy());
  });

  it('blocks describe-only and score-only clicks while a submission is in flight', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    mockCreate.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    renderAnalyzeTab();
    await screen.findByText(/Street/);

    // Open the advanced panel *before* submitting so the side buttons exist
    // in the DOM and the assertions don't race with conditional rendering.
    fireEvent.click(screen.getByRole('button', { name: /Advanced options/i }));
    const describeBtn = await screen.findByRole('button', { name: /Generate Descriptions only/i });
    const scoreBtn = await screen.findByRole('button', { name: /Run scoring only/i });

    // Start an analyze — both side buttons should now be disabled.
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }));
    expect(describeBtn.hasAttribute('disabled')).toBe(true);
    expect(scoreBtn.hasAttribute('disabled')).toBe(true);

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    fireEvent.click(describeBtn);
    fireEvent.click(scoreBtn);

    expect(mockCreate).toHaveBeenCalledTimes(1); // still just the analyze

    await act(async () => {
      resolveCreate({ id: 'first-job' });
    });
  });

  it('sends backfill_visual_tags in metadata when the Advanced backfill checkbox is checked', async () => {
    mockCreate.mockResolvedValue({ id: 'backfill-job', type: 'batch_describe' });

    renderAnalyzeTab();
    await screen.findByText(/Street/);

    fireEvent.click(screen.getByRole('button', { name: /Advanced options/i }));
    const backfill = await screen.findByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL });
    fireEvent.click(backfill);
    const describeOnly = await screen.findByRole('button', { name: /Generate Descriptions only/i });
    fireEvent.click(describeOnly);

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const [, batchMeta] = mockCreate.mock.calls[0] as [string, Record<string, unknown>];
    expect(batchMeta).toMatchObject({ backfill_visual_tags: true });
    expect(batchMeta.force).not.toBe(true);
    expect(batchMeta.force_describe).toBeUndefined();
    expect(batchMeta.force_score).toBeUndefined();
  });

  it('sends force_cull with the analyze job and warns what it does', async () => {
    mockCreate.mockResolvedValue({ id: 'recull-job', type: 'batch_analyze' });

    renderAnalyzeTab();
    await screen.findByText(/Street/);

    expect(screen.queryByText(ANALYZE_FORCE_CULL_HINT)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Force re-run culling' }));
    expect(screen.getByText(ANALYZE_FORCE_CULL_HINT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const [type, meta] = mockCreate.mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe('batch_analyze');
    expect(meta).toMatchObject({ force_cull: true, force_describe: false, force_score: false });
  });
});

function metadataHasBackfillWithForce(meta: Record<string, unknown>): boolean {
  if (meta.backfill_visual_tags !== true) return false;
  return (
    meta.force === true ||
    meta.force_describe === true ||
    meta.force_score === true
  );
}

describe('AnalyzeTab toggle mutual exclusivity', () => {
  beforeEach(() => {
    deleteMatching(() => true);
    mockCreate.mockReset();
    mockListPerspectives.mockReset();
    mockGetDefaults.mockReset();
    mockListPerspectives.mockResolvedValue([
      { slug: 'street', display_name: 'Street' },
    ]);
    mockGetDefaults.mockResolvedValue({ description: { provider: 'ollama', model: 'llava' } });
    mockCreate.mockResolvedValue({ id: 'job-id', type: 'batch_analyze' });
  });

  async function openAdvanced() {
    renderAnalyzeTab();
    await screen.findByText(/Street/);
    fireEvent.click(screen.getByRole('button', { name: /Advanced options/i }));
  }

  it('checking backfill clears and disables both force toggles with a hint', async () => {
    await openAdvanced();

    const forceDescribe = screen.getByRole('checkbox', { name: ANALYZE_FORCE_DESCRIBE_LABEL });
    const forceScore = screen.getByRole('checkbox', { name: ANALYZE_FORCE_SCORE_LABEL });
    const backfill = await screen.findByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL });

    fireEvent.click(forceDescribe);
    fireEvent.click(forceScore);
    expect(forceDescribe).toBeChecked();
    expect(forceScore).toBeChecked();

    fireEvent.click(backfill);

    expect(backfill).toBeChecked();
    expect(forceDescribe).not.toBeChecked();
    expect(forceScore).not.toBeChecked();
    expect(forceDescribe).toBeDisabled();
    expect(forceScore).toBeDisabled();
    expect(screen.getByText(ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT)).toBeTruthy();
  });

  it('checking force describe clears and disables backfill', async () => {
    await openAdvanced();

    const forceDescribe = screen.getByRole('checkbox', { name: ANALYZE_FORCE_DESCRIBE_LABEL });
    const backfill = await screen.findByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL });

    fireEvent.click(backfill);
    expect(backfill).toBeChecked();

    fireEvent.click(forceDescribe);

    expect(forceDescribe).toBeChecked();
    expect(backfill).not.toBeChecked();
    expect(backfill).toBeDisabled();
    expect(screen.getByText(ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT)).toBeTruthy();
  });

  it('checking force score clears and disables backfill', async () => {
    await openAdvanced();

    const forceScore = screen.getByRole('checkbox', { name: ANALYZE_FORCE_SCORE_LABEL });
    const backfill = await screen.findByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL });

    fireEvent.click(backfill);
    fireEvent.click(forceScore);

    expect(forceScore).toBeChecked();
    expect(backfill).not.toBeChecked();
    expect(backfill).toBeDisabled();
  });

  it('analyze submit metadata never combines backfill with force flags', async () => {
    await openAdvanced();

    fireEvent.click(screen.getByRole('checkbox', { name: ANALYZE_FORCE_DESCRIBE_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(metadataHasBackfillWithForce(mockCreate.mock.calls[0][1] as Record<string, unknown>)).toBe(false);

    mockCreate.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /^Analyze/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(metadataHasBackfillWithForce(mockCreate.mock.calls[0][1] as Record<string, unknown>)).toBe(false);
  });

  it('describe-only submit metadata never combines backfill with force', async () => {
    await openAdvanced();

    fireEvent.click(screen.getByRole('checkbox', { name: ANALYZE_FORCE_DESCRIBE_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /Generate Descriptions only/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(metadataHasBackfillWithForce(mockCreate.mock.calls[0][1] as Record<string, unknown>)).toBe(false);

    mockCreate.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: ANALYZE_BACKFILL_VISUAL_TAGS_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /Generate Descriptions only/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const meta = mockCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataHasBackfillWithForce(meta)).toBe(false);
    expect(meta).toMatchObject({ backfill_visual_tags: true, force: false });
  });

  it('score-only submit metadata never combines backfill with force', async () => {
    await openAdvanced();

    fireEvent.click(screen.getByRole('checkbox', { name: ANALYZE_FORCE_SCORE_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /Run scoring only/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    const meta = mockCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(metadataHasBackfillWithForce(meta)).toBe(false);
    expect(meta.backfill_visual_tags).toBeUndefined();
  });
});
