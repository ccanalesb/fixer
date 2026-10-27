import { Suspense } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { deleteMatching } from '../../../data/cache';
import { CatalogCacheTab } from '../CatalogCacheTab';
import {
  ADVANCED_OPTIONS_TITLE,
  CLIP_CONFIRM_DOWNLOAD_START,
  CLIP_CONFIRM_TITLE_JOB,
  CATALOG_CACHE_BUILD_CTA,
  CATALOG_CACHE_BUILD_SUCCESS,
  CATALOG_CACHE_EMBED_CATALOG_HELPER,
  CATALOG_CACHE_EMBED_CATALOG_LABEL,
  CATALOG_CACHE_LAST_RUN_NEVER,
  CATALOG_CACHE_NAS_TROUBLESHOOTING_DOC_URL,
  CATALOG_CACHE_NAS_TROUBLESHOOTING_LINK_LABEL,
  CATALOG_CACHE_PIPELINE_TITLE,
  CATALOG_CACHE_SIMILARITY_BEST_MATCH_PCT,
  CATALOG_CACHE_SIMILARITY_PREVIEW_TITLE,
  CATALOG_CACHE_SIMILARITY_TOTAL_GROUPS_LABEL,
  CATALOG_CACHE_STACK_DETECT_LABEL,
  CATALOG_CACHE_SYNC_HELPER,
  CATALOG_CACHE_SYNC_LABEL,
  PROCESSING_EMBED_CATALOG_QUEUED,
  PROCESSING_JOB_QUEUE_ROUTE,
  PROCESSING_OPEN_JOB_QUEUE,
} from '../../../constants/strings';

const mockCreate = vi.fn();
const mockFetch = vi.fn();
const mockListCatalogSimilarityGroups = vi.fn();
const mockUseClipModelStatus = vi.fn();

vi.mock('../../../hooks/useClipModelStatus', () => ({
  useClipModelStatus: () => mockUseClipModelStatus(),
}));

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return {
    ...actual,
    JobsAPI: {
      ...actual.JobsAPI,
      create: (...args: unknown[]) => mockCreate(...args),
    },
    ImagesAPI: {
      ...actual.ImagesAPI,
      listCatalogSimilarityGroups: (...args: unknown[]) => mockListCatalogSimilarityGroups(...args),
    },
  };
});

vi.stubGlobal('fetch', mockFetch);

function renderCatalogCacheTab(props: { onOpenJobQueue?: () => void } = {}) {
  return render(
    <MemoryRouter>
      <Suspense fallback={null}>
        <CatalogCacheTab {...props} />
      </Suspense>
    </MemoryRouter>,
  );
}

const EMPTY_PIPELINE_STATUS = {
  catalog_sync: null,
  embed_catalog: null,
  stack_detect: null,
  catalog_similarity: null,
  catalog_cache_build: null,
};

describe('CatalogCacheTab', () => {
  let pipelineStatusBody: typeof EMPTY_PIPELINE_STATUS | Record<string, unknown> = EMPTY_PIPELINE_STATUS;
  beforeEach(() => {
    deleteMatching(() => true);
    mockCreate.mockReset();
    mockFetch.mockReset();
    mockListCatalogSimilarityGroups.mockReset();
    mockListCatalogSimilarityGroups.mockResolvedValue({ items: [], total: 0 });
    mockUseClipModelStatus.mockReturnValue({ model_on_disk: true, cache_dir: '/clip' });
    pipelineStatusBody = EMPTY_PIPELINE_STATUS;
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof Request
            ? input.url
            : String(input);
      // Order matters — `/cache/pipeline-status` must match before
      // `/cache/status` since `includes` is a substring check.
      if (url.includes('/cache/pipeline-status')) {
        return Promise.resolve({
          ok: true,
          json: async () => pipelineStatusBody,
        });
      }
      if (url.includes('/cache/status')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            total_images: 10,
            cached_images: 5,
            missing: 5,
            cache_size_mb: 100,
            cache_dir: '/tmp/cache',
          }),
        });
      }
      return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
    });
  });

  it('renders primary Build catalog cache CTA', async () => {
    renderCatalogCacheTab();
    expect(await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA })).toBeTruthy();
  });

  it('links NAS troubleshooting copy to storage mount docs', async () => {
    renderCatalogCacheTab();
    const link = await screen.findByRole('link', {
      name: CATALOG_CACHE_NAS_TROUBLESHOOTING_LINK_LABEL,
    });
    expect(link).toHaveAttribute('href', CATALOG_CACHE_NAS_TROUBLESHOOTING_DOC_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Network share \(NAS\) paths must be mounted/)).toBeTruthy();
  });

  it('asks before Build catalog cache when the CLIP model is missing', async () => {
    mockUseClipModelStatus.mockReturnValue({ model_on_disk: false, cache_dir: '/clip' });
    renderCatalogCacheTab();
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText(CLIP_CONFIRM_TITLE_JOB)).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: CLIP_CONFIRM_DOWNLOAD_START }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('catalog_cache_build', expect.anything());
    });
  });

  it('asks before Embed catalog images when the CLIP model is missing', async () => {
    mockUseClipModelStatus.mockReturnValue({ model_on_disk: false, cache_dir: '/clip' });
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
    mockCreate.mockResolvedValue({ id: 'job-embed', type: 'batch_embed_image' });
    fireEvent.click(screen.getByRole('button', { name: CLIP_CONFIRM_DOWNLOAD_START }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('batch_embed_image', { image_type: 'catalog' });
    });
  });

  it('enqueues catalog_cache_build from primary CTA', async () => {
    mockCreate.mockResolvedValue({ id: 'job-chain', type: 'catalog_cache_build' });
    renderCatalogCacheTab();
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('catalog_cache_build', expect.anything());
    });
  });

  it('shows success copy and Open Job Queue after chain enqueue', async () => {
    mockCreate.mockResolvedValue({ id: 'job-chain', type: 'catalog_cache_build' });
    renderCatalogCacheTab();
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA }));
    expect(await screen.findByText(CATALOG_CACHE_BUILD_SUCCESS)).toBeTruthy();
    expect(screen.getByRole('button', { name: PROCESSING_OPEN_JOB_QUEUE })).toBeTruthy();
  });

  it('queue action invokes onOpenJobQueue or targets jobs route', async () => {
    mockCreate.mockResolvedValue({ id: 'job-chain', type: 'catalog_cache_build' });
    const onOpenJobQueue = vi.fn();
    renderCatalogCacheTab({ onOpenJobQueue });
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA }));
    const queueButton = await screen.findByRole('button', { name: PROCESSING_OPEN_JOB_QUEUE });
    fireEvent.click(queueButton);
    expect(onOpenJobQueue).toHaveBeenCalledTimes(1);
    expect(PROCESSING_JOB_QUEUE_ROUTE).toBe('/processing?tab=jobs');
  });

  it('reveals pipeline disclosure when toggled (no matching controls)', async () => {
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    expect(await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL })).toBeTruthy();
  });

  it('does not render matching-only controls (provider, weights, advanced options)', async () => {
    renderCatalogCacheTab();
    await screen.findByRole('button', { name: CATALOG_CACHE_BUILD_CTA });
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL });
    expect(screen.queryByText(ADVANCED_OPTIONS_TITLE)).toBeNull();
    expect(screen.queryByLabelText(/provider/i)).toBeNull();
    expect(screen.queryByLabelText(/threshold/i)).toBeNull();
  });

  it('fetches catalog similarity groups preview and renders group summary', async () => {
    mockListCatalogSimilarityGroups.mockResolvedValue({
      items: [
        {
          group_id: 7,
          seed: {
            id: 1,
            key: 'seed-key',
            filename: 's.jpg',
            filepath: '/tmp/s.jpg',
            date_taken: '2024-01-01',
            rating: 5,
            pick: false,
            color_label: '',
            keywords: [],
            title: '',
            caption: '',
            copyright: '',
            width: 100,
            height: 100,
            instagram_posted: false,
          },
          candidates: [
            {
              id: 2,
              key: 'cand-key',
              filename: 'c.jpg',
              filepath: '/tmp/c.jpg',
              date_taken: '2024-01-02',
              rating: 5,
              pick: false,
              color_label: '',
              keywords: [],
              title: '',
              caption: '',
              copyright: '',
              width: 100,
              height: 100,
              instagram_posted: false,
              similarity: 0.91,
            },
          ],
          candidate_count: 1,
          best_similarity: 0.91,
        },
      ],
      total: 22,
    });
    renderCatalogCacheTab();
    await waitFor(() => {
      expect(mockListCatalogSimilarityGroups).toHaveBeenCalledWith({ limit: 12, offset: 0 });
    });
    expect(await screen.findByText(CATALOG_CACHE_SIMILARITY_PREVIEW_TITLE)).toBeTruthy();
    expect(screen.getByText(CATALOG_CACHE_SIMILARITY_BEST_MATCH_PCT(91))).toBeTruthy();
    expect(screen.getByText(CATALOG_CACHE_SIMILARITY_TOTAL_GROUPS_LABEL(22))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute(
      'href',
      PROCESSING_JOB_QUEUE_ROUTE,
    );
  });

  it('enqueues catalog_sync from pipeline section', async () => {
    mockCreate.mockResolvedValue({ id: 'job-sync', type: 'catalog_sync' });
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_SYNC_LABEL }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('catalog_sync', {});
    });
  });

  it('renders sync helper copy in pipeline section', async () => {
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    expect(await screen.findByText(CATALOG_CACHE_SYNC_HELPER)).toBeTruthy();
  });

  it('enqueues batch_embed_image catalog-only from pipeline section', async () => {
    mockCreate.mockResolvedValue({ id: 'job-embed', type: 'batch_embed_image' });
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL }));
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith('batch_embed_image', { image_type: 'catalog' });
    });
  });

  it('shows success copy and Open Job Queue after embed enqueue', async () => {
    mockCreate.mockResolvedValue({ id: 'job-embed', type: 'batch_embed_image' });
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL }));
    expect(await screen.findByText(PROCESSING_EMBED_CATALOG_QUEUED)).toBeTruthy();
    expect(screen.getByRole('button', { name: PROCESSING_OPEN_JOB_QUEUE })).toBeTruthy();
  });

  it('renders helper copy and Never run badge when no pipeline jobs exist', async () => {
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    expect(await screen.findByText(CATALOG_CACHE_EMBED_CATALOG_HELPER)).toBeTruthy();
    // 4 pipeline rows (sync, catalog, stack, similarity) all
    // start with "Never run" until at least one job has been created.
    const neverBadges = await screen.findAllByText(CATALOG_CACHE_LAST_RUN_NEVER);
    expect(neverBadges.length).toBe(4);
  });

  it('renders status badge and relative timestamp for last run', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    pipelineStatusBody = {
      ...EMPTY_PIPELINE_STATUS,
      stack_detect: {
        job_id: 'job-stack',
        type: 'batch_stack_detect',
        status: 'completed',
        created_at: fiveMinAgo,
        started_at: fiveMinAgo,
        completed_at: fiveMinAgo,
        error: null,
      },
    };
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    await screen.findByRole('button', { name: CATALOG_CACHE_STACK_DETECT_LABEL });
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText(/Last run.*minutes? ago/)).toBeTruthy();
  });

  it('renders failed badge variant when last run failed', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    pipelineStatusBody = {
      ...EMPTY_PIPELINE_STATUS,
      embed_catalog: {
        job_id: 'job-embed',
        type: 'batch_embed_image',
        status: 'failed',
        created_at: oneHourAgo,
        started_at: oneHourAgo,
        completed_at: oneHourAgo,
        error: 'boom',
      },
    };
    renderCatalogCacheTab();
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(CATALOG_CACHE_PIPELINE_TITLE, 'i') }),
    );
    await screen.findByRole('button', { name: CATALOG_CACHE_EMBED_CATALOG_LABEL });
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText(/Last run.*hour/)).toBeTruthy();
  });
});
