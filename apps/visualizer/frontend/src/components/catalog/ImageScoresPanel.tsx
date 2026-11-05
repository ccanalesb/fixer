import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SCORES_EMPTY_HINT,
  SCORES_LOADING,
  SCORES_LOADING_HISTORY,
  SCORES_NO_PRIOR_VERSIONS,
  SCORES_OUTPUT_REPAIRED,
  SCORES_VERSION_HISTORY,
} from '../../constants/strings';
import type { ImageScoreRow } from '../../services/api';
import { ScoresAPI } from '../../services/api';
import { ErrorBoundary, ErrorState, keys, useQuery } from '../../data';
import { Badge } from '../ui/badges';

export interface ImageScoresPanelProps {
  imageKey: string;
  imageType?: 'catalog';
  /** Increment to refetch current scores (e.g. after a scoring job completes). */
  reloadToken?: number;
  /** Optional map slug → display name from `PerspectivesAPI.list`. */
  perspectiveLabels?: Record<string, string>;
}

function formatScoredAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function uniqueCurrentBySlug(rows: ImageScoreRow[]): ImageScoreRow[] {
  const map = new Map<string, ImageScoreRow>();
  for (const row of rows) {
    if (!map.has(row.perspective_slug)) {
      map.set(row.perspective_slug, row);
    }
  }
  return [...map.values()].sort((a, b) => a.perspective_slug.localeCompare(b.perspective_slug));
}

function ImageScoresPanelLoaded({
  imageKey,
  imageType = 'catalog',
  reloadToken = 0,
  perspectiveLabels,
}: ImageScoresPanelProps) {
  const payload = useQuery(
    keys.scores.current(imageKey, imageType, reloadToken),
    () => ScoresAPI.getCurrent(imageKey, { image_type: imageType }),
  );
  const current = useMemo(() => payload.current ?? [], [payload]);

  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(() => new Set());
  const [historyBySlug, setHistoryBySlug] = useState<Record<string, ImageScoreRow[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | null>>({});
  const prevExpandedRef = useRef<Set<string>>(new Set());
  const historyCacheRef = useRef(historyBySlug);
  historyCacheRef.current = historyBySlug;

  const rows = useMemo(() => uniqueCurrentBySlug(current), [current]);

  useEffect(() => {
    setExpandedSlugs(new Set());
    setHistoryBySlug({});
    setHistoryLoading({});
    setHistoryError({});
    prevExpandedRef.current = new Set();
  }, [imageKey, imageType, reloadToken]);

  const fetchHistoryFor = useCallback(
    async (slug: string) => {
      if (historyCacheRef.current[slug] !== undefined) return;
      setHistoryLoading((h) => ({ ...h, [slug]: true }));
      setHistoryError((h) => ({ ...h, [slug]: null }));
      try {
        const body = await ScoresAPI.getHistory(imageKey, {
          perspective_slug: slug,
          image_type: imageType,
        });
        setHistoryBySlug((c) => ({ ...c, [slug]: body.history ?? [] }));
      } catch (e) {
        setHistoryError((h) => ({ ...h, [slug]: String(e) }));
      } finally {
        setHistoryLoading((h) => ({ ...h, [slug]: false }));
      }
    },
    [imageKey, imageType],
  );

  useEffect(() => {
    const prev = prevExpandedRef.current;
    for (const slug of expandedSlugs) {
      if (!prev.has(slug)) {
        void fetchHistoryFor(slug);
      }
    }
    prevExpandedRef.current = new Set(expandedSlugs);
  }, [expandedSlugs, fetchHistoryFor]);

  const onToggleHistoryClick = useCallback((slug: string) => {
    setExpandedSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">{SCORES_EMPTY_HINT}</p>;
  }

  return (
    <div className="space-y-4">
      {rows.map((row) => {
        const label = perspectiveLabels?.[row.perspective_slug] ?? row.perspective_slug;
        const expanded = expandedSlugs.has(row.perspective_slug);
        const histLoading = historyLoading[row.perspective_slug];
        const histErr = historyError[row.perspective_slug];
        const historyRows = historyBySlug[row.perspective_slug];

        return (
          <div
            key={row.perspective_slug}
            className="rounded-base border border-border bg-bg/40 p-3 space-y-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text">{label}</span>
              <Badge variant="accent" className="tabular-nums">
                {row.score} / 10
              </Badge>
              <button
                type="button"
                onClick={() => onToggleHistoryClick(row.perspective_slug)}
                aria-expanded={expanded}
                className="ml-auto flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover transition-colors"
              >
                <svg
                  className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                {SCORES_VERSION_HISTORY}
              </button>
            </div>
            <p className="text-sm text-text-secondary whitespace-pre-wrap">{row.rationale}</p>
            <p className="text-xs text-text-tertiary">
              {row.model_used} · {row.prompt_version} · {formatScoredAt(row.scored_at)}
            </p>
            {row.repaired_from_malformed && (
              <p className="text-xs text-warning">{SCORES_OUTPUT_REPAIRED}</p>
            )}

            {expanded && (
              <div className="pt-2 border-t border-border space-y-2">
                {histLoading && (
                  <p className="text-xs text-text-tertiary">{SCORES_LOADING_HISTORY}</p>
                )}
                {histErr && <p className="text-xs text-error">{histErr}</p>}
                {!histLoading && !histErr && historyRows && historyRows.length === 0 && (
                  <p className="text-xs text-text-secondary">{SCORES_NO_PRIOR_VERSIONS}</p>
                )}
                {!histLoading &&
                  !histErr &&
                  historyRows &&
                  historyRows.map((h) => (
                    <div
                      key={`${h.perspective_slug}-${h.prompt_version}-${h.scored_at}-${h.id ?? ''}`}
                      className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
                    >
                      <span className="tabular-nums">{h.score} / 10</span>
                      <code className="text-[11px] bg-surface px-1.5 py-0.5 rounded border border-border">
                        {h.prompt_version}
                      </code>
                      <span>{formatScoredAt(h.scored_at)}</span>
                      {h.is_current ? (
                        <Badge variant="success">Latest</Badge>
                      ) : (
                        <Badge variant="default">Archived</Badge>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ImageScoresPanel(props: ImageScoresPanelProps) {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <ErrorState error={error} reset={reset} title="Could not load scores" />
      )}
    >
      <Suspense
        fallback={<p className="text-sm text-text-tertiary">{SCORES_LOADING}</p>}
      >
        <ImageScoresPanelLoaded {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
