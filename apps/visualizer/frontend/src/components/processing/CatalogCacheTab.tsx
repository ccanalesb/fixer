import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipModelDownloadConfirm } from '../setup/ClipModelDownloadConfirm';
import { useClipModelStatus } from '../../hooks/useClipModelStatus';
import { invalidateAll, useQuery } from '../../data';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
import { Button } from '../ui/Button';
import { Badge } from '../ui/badges';
import { CollapsibleSection } from '../ui/CollapsibleSection';
import { ImageTile, fromCatalogListRow } from '../image-view';
import {
  ImagesAPI,
  JobsAPI,
  SystemAPI,
  type CachePipelineRun,
  type CatalogSimilarityGroup,
} from '../../services/api';
import { formatTimeAgo } from '../../utils/date';
import {
  ANALYZE_PRIMARY_BUTTON_STARTING,
  CACHE_REFRESH_BUTTON,
  CATALOG_CACHE_BUILD_CTA,
  CATALOG_CACHE_BUILD_SUCCESS,
  CATALOG_CACHE_CARD_TITLE,
  CATALOG_CACHE_EMBED_CATALOG_HELPER,
  CATALOG_CACHE_EMBED_CATALOG_LABEL,
  CATALOG_CACHE_INTRO_BODY,
  CATALOG_CACHE_LAST_RUN_LABEL,
  CATALOG_CACHE_LAST_RUN_NEVER,
  CATALOG_CACHE_LOCATION_PREFIX,
  CATALOG_CACHE_NAS_TROUBLESHOOTING,
  CATALOG_CACHE_PIPELINE_JOB_QUEUED,
  CATALOG_CACHE_NAS_TROUBLESHOOTING_DOC_URL,
  CATALOG_CACHE_NAS_TROUBLESHOOTING_LINK_LABEL,
  CATALOG_CACHE_PIPELINE_TITLE,
  CATALOG_CACHE_PROGRESS_LABEL,
  CATALOG_CACHE_SIMILARITY_HELPER,
  CATALOG_CACHE_SIMILARITY_LABEL,
  CATALOG_CACHE_SIMILARITY_BEST_MATCH_PCT,
  CATALOG_CACHE_SIMILARITY_CANDIDATE_LABEL,
  CATALOG_CACHE_SIMILARITY_EMPTY,
  CATALOG_CACHE_SIMILARITY_PREVIEW_TITLE,
  CATALOG_CACHE_SIMILARITY_TOTAL_GROUPS_LABEL,
  CATALOG_CACHE_SIMILARITY_VIEW_ALL,
  CATALOG_CACHE_STACK_DETECT_HELPER,
  CATALOG_CACHE_STACK_DETECT_LABEL,
  CATALOG_CACHE_SYNC_HELPER,
  CATALOG_CACHE_SYNC_LABEL,
  CATALOG_CACHE_STAT_CACHED_HELPER,
  CATALOG_CACHE_STAT_CACHED_LABEL,
  CATALOG_CACHE_STAT_MISSING_HELPER,
  CATALOG_CACHE_STAT_MISSING_LABEL,
  CATALOG_CACHE_STAT_SIZE_HELPER,
  CATALOG_CACHE_STAT_SIZE_LABEL,
  CATALOG_CACHE_STAT_TOTAL_HELPER,
  CATALOG_CACHE_STAT_TOTAL_LABEL,
  PROCESSING_EMBED_CATALOG_QUEUED,
  PROCESSING_JOB_QUEUE_ROUTE,
  PROCESSING_OPEN_JOB_QUEUE,
  MSG_FAILED_START_JOB,
} from '../../constants/strings';

interface CacheStats {
  total_images: number;
  cached_images: number;
  missing: number;
  cache_size_mb: number;
  cache_dir: string;
}

async function fetchCacheStats(): Promise<CacheStats> {
  const response = await fetch('/api/cache/status');
  if (!response.ok) {
    throw new Error(`Cache status fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as CacheStats & { error?: string };
  if (data.error) {
    throw new Error(data.error);
  }
  return data;
}

type AdvancedBusyKey =
  | 'sync'
  | 'embed_catalog'
  | 'stack'
  | 'similarity';

type ClipConfirmAction =
  | { kind: 'build' }
  | { kind: 'embed' };

export interface CatalogCacheTabProps {
  onOpenJobQueue?: () => void;
}

export function CatalogCacheTab({ onOpenJobQueue }: CatalogCacheTabProps) {
  const [showPipeline, setShowPipeline] = useState(false);
  const [listRev, setListRev] = useState(0);
  const stats = useQuery(['catalog.cache.stats', listRev] as const, fetchCacheStats);
  const catalogSimilarity = useQuery(
    ['catalog.similarity.groups', { limit: 12, offset: 0 }] as const,
    () => ImagesAPI.listCatalogSimilarityGroups({ limit: 12, offset: 0 }),
  );
  const pipelineStatus = useQuery(
    ['catalog.cache.pipeline-status', listRev] as const,
    () => SystemAPI.cachePipelineStatus(),
  );

  const [buildStarting, setBuildStarting] = useState(false);
  const [buildSuccess, setBuildSuccess] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pipelineQueuedMessage, setPipelineQueuedMessage] = useState<string | null>(null);
  const [advancedBusy, setAdvancedBusy] = useState<AdvancedBusyKey | null>(null);
  const [clipConfirmAction, setClipConfirmAction] = useState<ClipConfirmAction | null>(null);

  const clipStatus = useClipModelStatus();
  const modelOnDisk = clipStatus.model_on_disk;

  const anyBusy = buildStarting || advancedBusy !== null;

  const refreshStats = useCallback(() => {
    invalidateAll(['catalog.cache.stats']);
    invalidateAll(['catalog.cache.pipeline-status']);
    setListRev((n) => n + 1);
  }, []);

  const handleOpenJobQueue = useCallback(() => {
    if (onOpenJobQueue) {
      onOpenJobQueue();
      return;
    }
    window.location.assign(PROCESSING_JOB_QUEUE_ROUTE);
  }, [onOpenJobQueue]);

  const runBuildCatalogCache = useCallback(async () => {
    setBuildStarting(true);
    setBuildSuccess(false);
    setBuildError(null);
    try {
      await JobsAPI.create('catalog_cache_build', {});
      setBuildSuccess(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : MSG_FAILED_START_JOB;
      setBuildError(message);
    } finally {
      setBuildStarting(false);
    }
  }, []);

  const handleBuildCatalogCache = useCallback(() => {
    if (!modelOnDisk) {
      setClipConfirmAction({ kind: 'build' });
      return;
    }
    void runBuildCatalogCache();
  }, [modelOnDisk, runBuildCatalogCache]);

  const pipelineQueuedMessageForKey = useCallback((key: AdvancedBusyKey): string => {
    if (key === 'embed_catalog') {
      return PROCESSING_EMBED_CATALOG_QUEUED;
    }
    const labels: Record<AdvancedBusyKey, string> = {
      sync: CATALOG_CACHE_SYNC_LABEL,
      stack: CATALOG_CACHE_STACK_DETECT_LABEL,
      similarity: CATALOG_CACHE_SIMILARITY_LABEL,
      embed_catalog: CATALOG_CACHE_EMBED_CATALOG_LABEL,
    };
    return CATALOG_CACHE_PIPELINE_JOB_QUEUED(labels[key]);
  }, []);

  const runAdvancedJob = useCallback(
    async (key: AdvancedBusyKey, type: string, metadata: Record<string, unknown>) => {
      setAdvancedBusy(key);
      setPipelineQueuedMessage(null);
      try {
        await JobsAPI.create(type, metadata);
        if (key === 'similarity') {
          invalidateAll(['catalog.similarity.groups']);
        }
        invalidateAll(['catalog.cache.pipeline-status']);
        setPipelineQueuedMessage(pipelineQueuedMessageForKey(key));
      } catch (err) {
        const message = err instanceof Error ? err.message : MSG_FAILED_START_JOB;
        alert(`${MSG_FAILED_START_JOB}: ${message}`);
      } finally {
        setAdvancedBusy(null);
      }
    },
    [pipelineQueuedMessageForKey],
  );

  const requestAdvancedJob = useCallback(
    (key: AdvancedBusyKey, type: string, metadata: Record<string, unknown>) => {
      if (key === 'embed_catalog' && !modelOnDisk) {
        setClipConfirmAction({ kind: 'embed' });
        return;
      }
      void runAdvancedJob(key, type, metadata);
    },
    [modelOnDisk, runAdvancedJob],
  );

  const confirmClipDownloadJob = useCallback(() => {
    const action = clipConfirmAction;
    setClipConfirmAction(null);
    if (!action) return;
    if (action.kind === 'build') {
      void runBuildCatalogCache();
      return;
    }
    void runAdvancedJob('embed_catalog', 'batch_embed_image', { image_type: 'catalog' });
  }, [clipConfirmAction, runAdvancedJob, runBuildCatalogCache]);

  const cachePercentage =
    stats.total_images > 0 ? Math.round((stats.cached_images / stats.total_images) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card padding="lg">
        <CardHeader>
          <CardTitle>{CATALOG_CACHE_CARD_TITLE}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary mb-6">{CATALOG_CACHE_INTRO_BODY}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="p-4 bg-surface rounded-base border border-border">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm text-text-secondary">{CATALOG_CACHE_STAT_TOTAL_LABEL}</span>
                <Badge variant="default">{stats.total_images.toLocaleString()}</Badge>
              </div>
              <p className="text-xs text-text-tertiary">{CATALOG_CACHE_STAT_TOTAL_HELPER}</p>
            </div>

            <div className="p-4 bg-surface rounded-base border border-border">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm text-text-secondary">{CATALOG_CACHE_STAT_CACHED_LABEL}</span>
                <Badge variant={cachePercentage === 100 ? 'success' : 'accent'}>
                  {stats.cached_images.toLocaleString()}
                </Badge>
              </div>
              <p className="text-xs text-text-tertiary">{CATALOG_CACHE_STAT_CACHED_HELPER}</p>
            </div>

            <div className="p-4 bg-surface rounded-base border border-border">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm text-text-secondary">{CATALOG_CACHE_STAT_MISSING_LABEL}</span>
                <Badge variant={stats.missing > 0 ? 'warning' : 'success'}>
                  {stats.missing.toLocaleString()}
                </Badge>
              </div>
              <p className="text-xs text-text-tertiary">{CATALOG_CACHE_STAT_MISSING_HELPER}</p>
            </div>

            <div className="p-4 bg-surface rounded-base border border-border">
              <div className="flex items-start justify-between mb-2">
                <span className="text-sm text-text-secondary">{CATALOG_CACHE_STAT_SIZE_LABEL}</span>
                <Badge variant="default">{stats.cache_size_mb.toFixed(1)} MB</Badge>
              </div>
              <p className="text-xs text-text-tertiary">{CATALOG_CACHE_STAT_SIZE_HELPER}</p>
            </div>
          </div>

          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-text">{CATALOG_CACHE_PROGRESS_LABEL}</span>
              <span className="text-sm text-text-secondary">{cachePercentage}%</span>
            </div>
            <div className="w-full bg-surface rounded-full h-3 border border-border">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${cachePercentage}%`,
                  backgroundColor:
                    cachePercentage === 100 ? 'var(--color-success)' : 'var(--color-accent)',
                }}
              />
            </div>
          </div>

          <div className="space-y-3 mb-6">
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={handleBuildCatalogCache}
              disabled={anyBusy}
            >
              {buildStarting ? ANALYZE_PRIMARY_BUTTON_STARTING : CATALOG_CACHE_BUILD_CTA}
            </Button>
            {buildSuccess ? (
              <div className="rounded-base border border-border bg-surface p-4 space-y-3">
                <p className="text-sm text-success" role="status">
                  {CATALOG_CACHE_BUILD_SUCCESS}
                </p>
                <Button variant="secondary" size="sm" type="button" onClick={handleOpenJobQueue}>
                  {PROCESSING_OPEN_JOB_QUEUE}
                </Button>
              </div>
            ) : null}
            {buildError ? (
              <p className="text-sm text-error" role="status">
                {MSG_FAILED_START_JOB}: {buildError}
              </p>
            ) : null}

            <CatalogSimilarityGroupsPreview
              groups={catalogSimilarity.items ?? []}
              total={catalogSimilarity.total}
            />
          </div>

          <CollapsibleSection
            title={CATALOG_CACHE_PIPELINE_TITLE}
            isOpen={showPipeline}
            onToggle={() => setShowPipeline(!showPipeline)}
          >
            <div className="space-y-3">
              <PipelineRow
                label={CATALOG_CACHE_SYNC_LABEL}
                helper={CATALOG_CACHE_SYNC_HELPER}
                lastRun={pipelineStatus.catalog_sync ?? null}
                disabled={anyBusy}
                isBusy={advancedBusy === 'sync'}
                onRun={() => runAdvancedJob('sync', 'catalog_sync', {})}
              />
              <PipelineRow
                label={CATALOG_CACHE_EMBED_CATALOG_LABEL}
                helper={CATALOG_CACHE_EMBED_CATALOG_HELPER}
                lastRun={pipelineStatus.embed_catalog ?? null}
                disabled={anyBusy}
                isBusy={advancedBusy === 'embed_catalog'}
                onRun={() =>
                  requestAdvancedJob('embed_catalog', 'batch_embed_image', { image_type: 'catalog' })
                }
              />
              <PipelineRow
                label={CATALOG_CACHE_STACK_DETECT_LABEL}
                helper={CATALOG_CACHE_STACK_DETECT_HELPER}
                lastRun={pipelineStatus.stack_detect ?? null}
                disabled={anyBusy}
                isBusy={advancedBusy === 'stack'}
                onRun={() => runAdvancedJob('stack', 'batch_stack_detect', {})}
              />
              <PipelineRow
                label={CATALOG_CACHE_SIMILARITY_LABEL}
                helper={CATALOG_CACHE_SIMILARITY_HELPER}
                lastRun={pipelineStatus.catalog_similarity ?? null}
                disabled={anyBusy}
                isBusy={advancedBusy === 'similarity'}
                onRun={() => runAdvancedJob('similarity', 'batch_catalog_similarity', {})}
              />
              {pipelineQueuedMessage ? (
                <div className="rounded-base border border-border bg-surface p-4 space-y-3">
                  <p className="text-sm text-success" role="status">
                    {pipelineQueuedMessage}
                  </p>
                  <Button variant="secondary" size="sm" type="button" onClick={handleOpenJobQueue}>
                    {PROCESSING_OPEN_JOB_QUEUE}
                  </Button>
                </div>
              ) : null}
            </div>
          </CollapsibleSection>

          <div className="pt-4">
            <Button variant="secondary" size="md" fullWidth onClick={refreshStats} disabled={anyBusy}>
              {CACHE_REFRESH_BUTTON}
            </Button>
          </div>

          <div className="mt-4 p-3 bg-surface rounded-base border border-border">
            <p className="text-xs text-text-tertiary">
              <strong>{CATALOG_CACHE_LOCATION_PREFIX}</strong> {stats.cache_dir}
            </p>
          </div>
          <p className="text-xs text-text-tertiary mt-2">
            {CATALOG_CACHE_NAS_TROUBLESHOOTING}{' '}
            <a
              href={CATALOG_CACHE_NAS_TROUBLESHOOTING_DOC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent hover:underline"
            >
              {CATALOG_CACHE_NAS_TROUBLESHOOTING_LINK_LABEL}
            </a>
            .
          </p>
        </CardContent>
      </Card>

      {clipConfirmAction ? (
        <ClipModelDownloadConfirm
          variant="job"
          busy={buildStarting || advancedBusy === 'embed_catalog'}
          onCancel={() => setClipConfirmAction(null)}
          onConfirm={confirmClipDownloadJob}
        />
      ) : null}
    </div>
  );
}

type PipelineRowProps = {
  label: string;
  helper: string;
  lastRun: CachePipelineRun | null;
  disabled: boolean;
  isBusy: boolean;
  onRun: () => void;
};

/** Row within the Pipeline stages disclosure: helper text on the left,
 * "Last run" badge below, action button on the right. Stays vertical on
 * narrow viewports because the helper text is the most important hint. */
function PipelineRow({ label, helper, lastRun, disabled, isBusy, onRun }: PipelineRowProps) {
  return (
    <div className="flex flex-col gap-2 rounded-base border border-border bg-white p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-semibold text-text">{label}</h3>
        <p className="text-xs leading-relaxed text-text-secondary">{helper}</p>
        <LastRunBadge run={lastRun} />
      </div>
      <div className="shrink-0">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={onRun}
        >
          {isBusy ? ANALYZE_PRIMARY_BUTTON_STARTING : label}
        </Button>
      </div>
    </div>
  );
}

function lastRunBadgeVariant(status: string): 'success' | 'warning' | 'error' | 'accent' | 'default' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'running':
    case 'pending':
      return 'accent';
    default:
      return 'default';
  }
}

function LastRunBadge({ run }: { run: CachePipelineRun | null }) {
  if (!run) {
    return (
      <p className="text-xs text-text-tertiary" data-testid="catalog-cache-last-run">
        {CATALOG_CACHE_LAST_RUN_NEVER}
      </p>
    );
  }
  const referenceTimestamp = run.completed_at ?? run.started_at ?? run.created_at;
  const ago = formatTimeAgo(referenceTimestamp);
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="catalog-cache-last-run">
      <Badge variant={lastRunBadgeVariant(run.status)}>{run.status}</Badge>
      <span className="text-xs text-text-secondary" title={referenceTimestamp ?? undefined}>
        {CATALOG_CACHE_LAST_RUN_LABEL(ago)}
      </span>
    </div>
  );
}

function CatalogSimilarityGroupsPreview({
  groups,
  total,
}: {
  groups: CatalogSimilarityGroup[]
  total?: number
}) {
  if (groups.length === 0) {
    return (
      <p className="rounded-base border border-border bg-surface p-4 text-sm text-text-secondary">
        {CATALOG_CACHE_SIMILARITY_EMPTY}
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-text">{CATALOG_CACHE_SIMILARITY_PREVIEW_TITLE}</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-text-secondary">
            {CATALOG_CACHE_SIMILARITY_TOTAL_GROUPS_LABEL(total ?? groups.length)}
          </span>
          <Link
            to={PROCESSING_JOB_QUEUE_ROUTE}
            className="text-xs font-medium text-accent hover:underline"
          >
            {CATALOG_CACHE_SIMILARITY_VIEW_ALL}
          </Link>
        </div>
      </div>
      <div className="space-y-4">
        {groups.map((group) => (
          <div key={group.group_id} className="rounded-base border border-border bg-surface p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-text">
                {CATALOG_CACHE_SIMILARITY_BEST_MATCH_PCT(Math.round(group.best_similarity * 100))}
              </span>
              <span className="text-xs text-text-secondary">
                {CATALOG_CACHE_SIMILARITY_CANDIDATE_LABEL(group.candidate_count)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <ImageTile
                image={fromCatalogListRow(group.seed)}
                variant="strip"
                primaryScoreSource="catalog"
                onClick={() => {}}
              />
              {group.candidates.slice(0, 3).map((candidate) => (
                <div key={candidate.key} className="space-y-1">
                  <ImageTile
                    image={fromCatalogListRow(candidate)}
                    variant="strip"
                    primaryScoreSource="catalog"
                    onClick={() => {}}
                  />
                  <p className="text-center text-xs text-text-secondary">
                    {Math.round((candidate.similarity ?? 0) * 100)}%
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
