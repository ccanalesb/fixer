import { useState, useEffect, useCallback } from 'react';
import type { MouseEvent } from 'react';
import { JobsAPI } from '../../services/api';
import type { Job } from '../../types/job';
import { JobDetailModal } from '../jobs/JobDetailModal';
import { Badge } from '../ui/badges';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Pagination } from '../ui/Pagination';
import { JOB_QUEUE_PAGINATION_RANGE } from '../../constants/strings';
import { jobTypeLabel } from '../../utils/jobTypeLabel';

function getStatusVariant(status: Job['status']): 'default' | 'success' | 'warning' | 'error' | 'accent' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'running':
      return 'accent';
    case 'cancelled':
      return 'warning';
    case 'pending':
      return 'default';
  }
}

function progressWidthPercent(job: Job): number {
  const p = job.progress ?? 0;
  return Math.min(100, p <= 1 ? p * 100 : p);
}

export interface JobQueueTabPagination {
  offset: number;
  limit: number;
  total: number;
}

export interface JobQueueTabProps {
  jobs: Job[];
  connected: boolean;
  onRefreshJobs: () => void | Promise<void>;
  onInvalidateJobList: () => void;
  isPending?: boolean;
  pagination: JobQueueTabPagination;
  onOffsetChange: (offset: number) => void;
}

export function JobQueueTab({
  jobs,
  connected,
  onRefreshJobs,
  isPending = false,
  pagination,
  onOffsetChange,
}: JobQueueTabProps) {
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleCloseModal = useCallback(() => setSelectedJob(null), []);

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  const rangeStart = pagination.total === 0 ? 0 : pagination.offset + 1;
  const rangeEnd = Math.min(pagination.offset + jobs.length, pagination.total);
  const handlePageChange = (page: number) => {
    const nextOffset = Math.max(0, (page - 1) * pagination.limit);
    if (nextOffset !== pagination.offset) {
      onOffsetChange(nextOffset);
    }
  };

  const cancelJob = async (jobId: string, e: MouseEvent) => {
    e.stopPropagation();
    setCancellingId(jobId);
    try {
      await JobsAPI.cancel(jobId);
      // List is updated by the job_updated socket event (patchMatching),
      // so no explicit invalidation is needed here.
    } catch (err) {
      alert(`Failed to cancel job: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setCancellingId(null);
    }
  };

  const retryJob = async (jobId: string, e: MouseEvent) => {
    e.stopPropagation();
    setRetryingId(jobId);
    try {
      await JobsAPI.retry(jobId);
      // Same as cancelJob — socket handles the list patch.
    } catch (err) {
      alert(`Failed to retry job: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRetryingId(null);
    }
  };

  useEffect(() => {
    setSelectedJob((prev) => {
      if (!prev) return null;
      const match = jobs.find((j) => j.id === prev.id);
      return match ?? prev;
    });
  }, [jobs]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-success' : 'bg-error'}`} />
          <span className="text-sm text-text-secondary">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void onRefreshJobs();
          }}
        >
          Refresh
        </Button>
      </div>

      {jobs.length === 0 ? (
        <Card padding="lg">
          <div className="text-center py-12">
            <svg
              className="mx-auto h-12 w-12 text-text-tertiary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <h3 className="mt-2 text-sm font-medium text-text">No jobs</h3>
            <p className="mt-1 text-sm text-text-secondary">
              Start a matching or description job to see it here
            </p>
          </div>
        </Card>
      ) : (
        <Card padding="none">
          <div className={`overflow-x-auto transition-opacity duration-150${isPending ? ' opacity-50 pointer-events-none' : ''}`}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Progress
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => setSelectedJob(job)}
                    className="hover:bg-surface cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-text">{jobTypeLabel(job.type)}</div>
                      <div className="text-xs text-text-tertiary font-mono">{job.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Badge variant={getStatusVariant(job.status)}>{job.status}</Badge>
                    </td>
                    <td className="px-6 py-4 text-sm text-text-secondary whitespace-nowrap">
                      {new Date(job.created_at).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      {job.status === 'running' && (
                        <div className="w-full bg-surface rounded-full h-2">
                          <div
                            className="bg-accent h-2 rounded-full transition-all duration-300"
                            style={{ width: `${progressWidthPercent(job)}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right text-sm space-x-2">
                      {(job.status === 'pending' || job.status === 'running') && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={(e) => cancelJob(job.id, e)}
                          disabled={cancellingId === job.id}
                          type="button"
                        >
                          {cancellingId === job.id ? 'Cancelling...' : 'Cancel'}
                        </Button>
                      )}
                      {(job.status === 'failed' || job.status === 'cancelled') && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(e) => retryJob(job.id, e)}
                          disabled={retryingId === job.id}
                          type="button"
                        >
                          {retryingId === job.id ? 'Retrying...' : 'Retry'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination.total > pagination.limit && (
            <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
              <span className="text-xs text-text-secondary">
                {JOB_QUEUE_PAGINATION_RANGE(rangeStart, rangeEnd, pagination.total)}
              </span>
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={handlePageChange}
                disabled={false}
              />
            </div>
          )}
        </Card>
      )}

      {selectedJob && (
        <JobDetailModal job={selectedJob} onClose={handleCloseModal} />
      )}
    </div>
  );
}
