import { Suspense, useCallback, useState, useTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, Tab } from '../components/ui/Tabs';
import { AnalyzeTab } from '../components/processing/AnalyzeTab';
import { CatalogCacheTab } from '../components/processing/CatalogCacheTab';
import { JobQueueTab } from '../components/processing/JobQueueTab';
import { JobsHealthBanner } from '../components/processing/JobsHealthBanner';
import { ProvidersTab } from '../components/processing/ProvidersTab';
import { SettingsTab } from '../components/processing/SettingsTab';
import { PerspectivesTab } from '../components/processing/PerspectivesTab';
import { CullReviewTab } from '../components/cull/CullReviewTab';
import { Button } from '../components/ui/Button';
import { useJobSocket } from '../hooks/useJobSocket';
import { usePageTab } from '../hooks/usePageTab';
import { JobsAPI } from '../services/api';
import { ErrorBoundary, ErrorState, invalidateAll, useQuery } from '../data';
import { AnalyzeOptionsProvider } from '../stores/analyzeOptionsContext';
import { PROCESSING_TAB_IDS, usePageUiStore } from '../stores/pageUiStore';
import {
  TAB_ANALYZE,
  TAB_CULL,
  TAB_PERSPECTIVES,
  TAB_CATALOG_CACHE,
  TAB_JOB_QUEUE,
  TAB_PROVIDERS,
  TAB_SETTINGS,
  NAV_PROCESSING,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../constants/strings';

const PAGE_SIZE = 50;

const JOBS_RECOVERED_BANNER =
  'Some jobs were automatically resumed after the last server restart. Check the job queue for progress.';

const tabSuspenseFallback = (
  <div className="rounded-card border border-border bg-surface p-8 text-center text-sm text-text-secondary">
    Loading…
  </div>
);

function JobQueueTabWithData({
  connected,
  refreshJobList,
}: {
  connected: boolean;
  refreshJobList: () => void;
}) {
  const [jobsOffset, setJobsOffset] = useState(0);
  const [isPending, startTransition] = useTransition();
  const listResponse = useQuery(
    ['jobs.list', { limit: PAGE_SIZE, offset: jobsOffset }] as const,
    () => JobsAPI.list({ limit: PAGE_SIZE, offset: jobsOffset }),
  );

  const jobs = Array.isArray(listResponse?.data) ? listResponse.data : [];
  const jobsTotal = typeof listResponse?.total === 'number' ? listResponse.total : 0;

  return (
    <JobQueueTab
      jobs={jobs}
      connected={connected}
      onRefreshJobs={refreshJobList}
      onInvalidateJobList={refreshJobList}
      isPending={isPending}
      pagination={{
        offset: jobsOffset,
        limit: PAGE_SIZE,
        total: jobsTotal,
      }}
      onOffsetChange={(offset) => startTransition(() => setJobsOffset(offset))}
    />
  );
}

export function ProcessingPage() {
  const navigate = useNavigate();
  const processingTab = usePageUiStore((s) => s.processingTab);
  const setProcessingTab = usePageUiStore((s) => s.setProcessingTab);
  const { activeTab, handleTabChange } = usePageTab({
    pagePath: '/processing',
    tabIds: PROCESSING_TAB_IDS,
    defaultTab: 'analyze',
    storedTab: processingTab,
    setStoredTab: setProcessingTab,
  });

  const [jobsRecoveredBanner, setJobsRecoveredBanner] = useState<string | null>(null);

  const { connected, jobListRevision, refreshJobList } = useJobSocket({
    onJobsRecovered: () => setJobsRecoveredBanner(JOBS_RECOVERED_BANNER),
  });
  // jobListRevision drives ProcessingPage re-renders so JobQueueTabWithData
  // re-renders after invalidateAll(['jobs.list']) clears the cache.
  void jobListRevision;

  const openJobQueueTab = useCallback(() => {
    navigate(PROCESSING_JOB_QUEUE_ROUTE, { replace: true });
  }, [navigate]);

  const tabs: Tab[] = [
    {
      id: 'analyze',
      label: TAB_ANALYZE,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState error={error} reset={reset} title="Could not load analyze tab" />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <AnalyzeOptionsProvider>
              <AnalyzeTab />
            </AnalyzeOptionsProvider>
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'cull',
      label: TAB_CULL,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['cull.summary', 'cull.photos']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <CullReviewTab />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'perspectives',
      label: TAB_PERSPECTIVES,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['perspectives']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <PerspectivesTab />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'cache',
      label: TAB_CATALOG_CACHE,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['catalog.cache.stats']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <CatalogCacheTab onOpenJobQueue={openJobQueueTab} />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'jobs',
      label: TAB_JOB_QUEUE,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['jobs.list']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <JobQueueTabWithData
              connected={connected}
              refreshJobList={refreshJobList}
            />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'providers',
      label: TAB_PROVIDERS,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['providers.list']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <ProvidersTab />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    { id: 'settings', label: TAB_SETTINGS, content: <SettingsTab /> },
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-section text-text mb-2">{NAV_PROCESSING}</h1>
        <p className="text-text-secondary">
          Descriptions, scoring, catalog cache management, and job monitoring
        </p>
      </div>

      <JobsHealthBanner />

      {jobsRecoveredBanner ? (
        <div
          className="mb-4 flex items-start justify-between gap-4 rounded-card border border-border bg-surface p-4 shadow-card"
          role="status"
        >
          <p className="text-sm text-text">{jobsRecoveredBanner}</p>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setJobsRecoveredBanner(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
    </div>
  );
}
