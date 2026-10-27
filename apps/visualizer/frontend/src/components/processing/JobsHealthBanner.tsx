import { Suspense, useEffect, useState } from 'react';
import { ErrorBoundary, invalidateAll, useQuery } from '../../data';
import { JobsAPI } from '../../services/api';

export interface JobsHealthBannerProps {
  /** Polling interval in ms. Defaults to 30s. Set to 0 to disable polling. */
  pollIntervalMs?: number;
}

function JobsHealthBannerBody({
  pollIntervalMs,
}: Required<Pick<JobsHealthBannerProps, 'pollIntervalMs'>>) {
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    if (pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => {
      invalidateAll(['jobs.health']);
      setPollTick((n) => n + 1);
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollIntervalMs]);

  const health = useQuery(
    ['jobs.health', pollTick] as const,
    () => JobsAPI.health(),
  );

  if (!health || health.catalog_available) {
    return null;
  }

  const reason =
    health.library_db.reason ??
    'Lightroom Classic catalog database is unavailable. Catalog-dependent jobs cannot run.';

  return (
    <div
      className="mb-4 rounded-card border border-error bg-error/10 p-4"
      role="alert"
      data-testid="jobs-health-banner-unavailable"
    >
      <p className="text-sm font-semibold text-text">Catalog unavailable</p>
      <p className="mt-1 text-sm text-text-secondary">{reason}</p>
      {health.library_db.path ? (
        <p className="mt-2 text-xs text-text-tertiary font-mono">
          library_db: {health.library_db.path} (source: {health.library_db.source})
        </p>
      ) : null}
      <p className="mt-2 text-xs text-text-tertiary">
        Blocked job types: {health.jobs_requiring_catalog.join(', ')}
      </p>
    </div>
  );
}

function JobsHealthErrorBanner({ error }: { error: Error }) {
  return (
    <div
      className="mb-4 rounded-card border border-error bg-error/10 p-4 text-sm text-text"
      role="alert"
      data-testid="jobs-health-banner-error"
    >
      <strong className="font-semibold">Could not reach job health endpoint.</strong>{' '}
      <span className="text-text-secondary">{error.message}</span>
    </div>
  );
}

/**
 * Surface backend catalog-availability problems on the Processing page.
 *
 * Polls ``/api/jobs/health`` and renders an error banner when the Lightroom Classic
 * catalog SQLite mirror is missing/misconfigured. This warns the user *before*
 * they enqueue a job that will either fail immediately or deadlock the queue.
 */
export function JobsHealthBanner({ pollIntervalMs = 30_000 }: JobsHealthBannerProps) {
  return (
    <ErrorBoundary
      resetKeys={[pollIntervalMs]}
      fallback={({ error }) => <JobsHealthErrorBanner error={error} />}
    >
      <Suspense fallback={null}>
        <JobsHealthBannerBody pollIntervalMs={pollIntervalMs} />
      </Suspense>
    </ErrorBoundary>
  );
}
