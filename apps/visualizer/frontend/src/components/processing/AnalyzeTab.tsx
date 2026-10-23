import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '../../data';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
import { Button } from '../ui/Button';
import { WorkerSlider } from '../ui/WorkerSlider';
import { ProviderModelSelect } from '../ui/ProviderModelSelect';
import { useAnalyzeOptions } from '../../stores/analyzeOptionsContext';
import { JobsAPI, PerspectivesAPI, ProvidersAPI } from '../../services/api';
import {
  ADVANCED_DATE_12MONTHS,
  ADVANCED_DATE_18MONTHS,
  ADVANCED_DATE_1MONTH,
  ADVANCED_DATE_24MONTHS,
  ADVANCED_DATE_2MONTHS,
  ADVANCED_DATE_3MONTHS,
  ADVANCED_DATE_6MONTHS,
  ADVANCED_DATE_9MONTHS,
  ADVANCED_DATE_ALL,
  ADVANCED_DATE_YEAR_2023,
  ADVANCED_DATE_YEAR_2024,
  ADVANCED_DATE_YEAR_2025,
  ADVANCED_DATE_YEAR_2026,
  ADVANCED_OPTIONS_TITLE,
  ANALYZE_ADVANCED_DESCRIBE_ONLY,
  ANALYZE_ADVANCED_RUN_SEPARATELY_TITLE,
  ANALYZE_ADVANCED_SCORE_ONLY,
  ANALYZE_CARD_SUBTITLE,
  ANALYZE_CARD_TITLE,
  ANALYZE_DESCRIBE_JOB_STARTED,
  ANALYZE_FORCE_CULL_HINT,
  ANALYZE_FORCE_CULL_LABEL,
  ANALYZE_FORCE_DESCRIBE_LABEL,
  ANALYZE_FORCE_SCORE_LABEL,
  ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT,
  ANALYZE_BACKFILL_VISUAL_TAGS_LABEL,
  ANALYZE_JOB_FAILED_PREFIX,
  ANALYZE_JOB_STARTED,
  ANALYZE_PRIMARY_BUTTON,
  ANALYZE_PRIMARY_BUTTON_STARTING,
  ANALYZE_SCORE_JOB_STARTED,
  CULLING_CHECKING,
} from '../../constants/strings';
import { useCullingGate } from '../cull/useCullingGate';

// Date-filter options mirror the richer contract MatchingTab uses. The value
// is either ``'all'`` (no window), ``'<N>months'`` (last-N-months rolling
// window), or a four-digit year (specific calendar year). The backend
// ``_resolve_date_window`` helper accepts these as ``last_months: N`` or
// ``year: 'YYYY'`` — we translate in ``buildDateMetadata`` below.
type DateFilter =
  | 'all'
  | '1months'
  | '2months'
  | '3months'
  | '6months'
  | '9months'
  | '12months'
  | '18months'
  | '24months'
  | '2026'
  | '2025'
  | '2024'
  | '2023';

const DATE_FILTER_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'all', label: ADVANCED_DATE_ALL },
  { value: '1months', label: ADVANCED_DATE_1MONTH },
  { value: '2months', label: ADVANCED_DATE_2MONTHS },
  { value: '3months', label: ADVANCED_DATE_3MONTHS },
  { value: '6months', label: ADVANCED_DATE_6MONTHS },
  { value: '9months', label: ADVANCED_DATE_9MONTHS },
  { value: '12months', label: ADVANCED_DATE_12MONTHS },
  { value: '18months', label: ADVANCED_DATE_18MONTHS },
  { value: '24months', label: ADVANCED_DATE_24MONTHS },
  { value: '2026', label: ADVANCED_DATE_YEAR_2026 },
  { value: '2025', label: ADVANCED_DATE_YEAR_2025 },
  { value: '2024', label: ADVANCED_DATE_YEAR_2024 },
  { value: '2023', label: ADVANCED_DATE_YEAR_2023 },
];

// Translate a ``DateFilter`` enum value into the metadata keys the backend
// expects. Exported for unit testing.
// eslint-disable-next-line react-refresh/only-export-components
export function buildDateMetadata(
  filter: DateFilter,
): { last_months?: number; year?: string; date_filter: DateFilter } {
  const base = { date_filter: filter };
  if (filter === 'all') return base;
  const monthsMatch = /^(\d+)months$/.exec(filter);
  if (monthsMatch) return { ...base, last_months: Number(monthsMatch[1]) };
  if (/^\d{4}$/.test(filter)) return { ...base, year: filter };
  return base;
}

export function AnalyzeTab() {
  const { options, updateOption } = useAnalyzeOptions();
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [batchMinRating, setBatchMinRating] = useState<number | null>(null);
  const [forceCull, setForceCull] = useState(false);
  const [forceDescribe, setForceDescribe] = useState(false);
  const [forceScore, setForceScore] = useState(false);
  const [backfillVisualTags, setBackfillVisualTags] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isStartingAnalyze, setIsStartingAnalyze] = useState(false);
  const [isStartingDescribe, setIsStartingDescribe] = useState(false);
  const [isStartingScore, setIsStartingScore] = useState(false);
  // Inline status banner — replaces the jarring window.alert() that used to
  // be the only feedback. ``tone`` selects the colour; ``message`` is shown
  // until cleared (either by a later submission or by the auto-dismiss
  // timeout). ``jobId`` is surfaced so the user can cross-reference the
  // queue entry immediately without waiting for the socket refresh.
  const [statusBanner, setStatusBanner] = useState<
    { tone: 'success' | 'error'; message: string; jobId?: string } | null
  >(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cross-button synchronous guard: React's ``isStartingX`` flags are set
  // asynchronously, so two rapid clicks on the *same* button can both see
  // ``false`` and both fire a POST. A ref-backed guard closes that window
  // and additionally blocks concurrent clicks across all three submit
  // buttons — a single batch submission at a time is the contract.
  const submitInFlightRef = useRef(false);
  const { run: runCullingGate, checking: checkingCulling, dialog: cullingDialog } = useCullingGate();

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  const showStatus = useCallback(
    (tone: 'success' | 'error', message: string, jobId?: string) => {
      setStatusBanner({ tone, message, jobId });
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      // Success messages auto-dismiss so they don't pile up; errors stay
      // until the user clicks Dismiss or triggers another submission.
      if (tone === 'success') {
        statusTimerRef.current = setTimeout(() => setStatusBanner(null), 6000);
      }
    },
    [],
  );
  const [descProviderId, setDescProviderId] = useState<string | null>(null);
  const [descProviderModel, setDescProviderModel] = useState<string | null>(null);
  const [activePerspectiveRows, setActivePerspectiveRows] = useState<
    { slug: string; display_name: string }[]
  >([]);
  const [selectedPerspectiveSlugs, setSelectedPerspectiveSlugs] = useState<string[]>([]);

  const perspectives = useQuery(['perspectives', 'list', 'active'] as const, () =>
    PerspectivesAPI.list({ active_only: true }),
  );

  const defaults = useQuery(['providers.defaults'] as const, () => ProvidersAPI.getDefaults());

  useEffect(() => {
    const sorted = [...perspectives].sort((a, b) => a.slug.localeCompare(b.slug));
    setActivePerspectiveRows(sorted.map((r) => ({ slug: r.slug, display_name: r.display_name })));
    setSelectedPerspectiveSlugs((prev) =>
      prev.length > 0 ? prev : sorted.map((r) => r.slug),
    );
  }, [perspectives]);

  useEffect(() => {
    if (defaults.description?.provider) {
      setDescProviderId(defaults.description.provider);
      setDescProviderModel(defaults.description.model ?? null);
    }
  }, [defaults]);

  const buildSharedBaseMetadata = useCallback((): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {
      image_type: 'catalog',
      ...buildDateMetadata(dateFilter),
      max_workers: options.maxWorkers,
    };
    if (batchMinRating !== null) metadata.min_rating = batchMinRating;
    if (descProviderId) metadata.provider_id = descProviderId;
    if (descProviderModel) metadata.provider_model = descProviderModel;
    metadata.perspective_slugs = [...selectedPerspectiveSlugs];
    return metadata;
  }, [
    dateFilter,
    batchMinRating,
    options.maxWorkers,
    descProviderId,
    descProviderModel,
    selectedPerspectiveSlugs,
  ]);

  const handleForceDescribeChange = (checked: boolean) => {
    setForceDescribe(checked);
    if (checked) setBackfillVisualTags(false);
  };

  const handleForceScoreChange = (checked: boolean) => {
    setForceScore(checked);
    if (checked) setBackfillVisualTags(false);
  };

  const handleBackfillVisualTagsChange = (checked: boolean) => {
    setBackfillVisualTags(checked);
    if (checked) {
      setForceDescribe(false);
      setForceScore(false);
    }
  };

  const buildBatchJobMetadata = useCallback((): Record<string, unknown> => {
    return {
      ...buildSharedBaseMetadata(),
      force_cull: forceCull,
      force_describe: forceDescribe,
      force_score: forceScore,
      backfill_visual_tags: backfillVisualTags,
    };
  }, [buildSharedBaseMetadata, forceCull, forceDescribe, forceScore, backfillVisualTags]);

  // Shared submission core: guards against double-submission (both from React's
  // async state and from cross-button clicks), runs the POST, shows an inline
  // status banner, and always clears its in-flight flag so the UI can't get
  // stuck "disabled forever" if something throws.
  const runSubmit = useCallback(
    async (
      jobType: 'batch_analyze' | 'batch_describe' | 'batch_score',
      metadata: Record<string, unknown>,
      successMessage: string,
      setStarting: (v: boolean) => void,
    ) => {
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      setStarting(true);
      // Clear any prior banner so the user doesn't see a stale success
      // message while the new submission is still in flight.
      setStatusBanner(null);
      const failed = (error: unknown) => {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        showStatus('error', `${ANALYZE_JOB_FAILED_PREFIX} ${msg}`);
      };
      try {
        await runCullingGate('start', async () => {
          try {
            const job = await JobsAPI.create(jobType, metadata);
            showStatus('success', successMessage, job.id);
          } catch (error) {
            failed(error);
          }
        });
      } catch (error) {
        failed(error);
      } finally {
        setStarting(false);
        submitInFlightRef.current = false;
      }
    },
    [showStatus, runCullingGate],
  );

  const startAnalyze = useCallback(() => {
    void runSubmit(
      'batch_analyze',
      buildBatchJobMetadata(),
      ANALYZE_JOB_STARTED,
      setIsStartingAnalyze,
    );
  }, [runSubmit, buildBatchJobMetadata]);

  const startDescriptionsOnly = useCallback(() => {
    void runSubmit(
      'batch_describe',
      {
        ...buildSharedBaseMetadata(),
        force: forceDescribe,
        backfill_visual_tags: backfillVisualTags,
      },
      ANALYZE_DESCRIBE_JOB_STARTED,
      setIsStartingDescribe,
    );
  }, [runSubmit, buildSharedBaseMetadata, forceDescribe, backfillVisualTags]);

  const startScoringOnly = useCallback(() => {
    void runSubmit(
      'batch_score',
      { ...buildSharedBaseMetadata(), force: forceScore },
      ANALYZE_SCORE_JOB_STARTED,
      setIsStartingScore,
    );
  }, [runSubmit, buildSharedBaseMetadata, forceScore]);

  // Any in-flight submission disables all submit buttons — prevents a
  // "while batch_analyze is submitting, click describe-only too" footgun.
  const isAnySubmitting = isStartingAnalyze || isStartingDescribe || isStartingScore;
  const startingLabel = checkingCulling ? CULLING_CHECKING : ANALYZE_PRIMARY_BUTTON_STARTING;

  return (
    <div>
      <Card padding="lg">
        <CardHeader>
          <CardTitle>{ANALYZE_CARD_TITLE}</CardTitle>
        </CardHeader>

        <CardContent>
          <div className="space-y-6">
            <p className="text-sm text-text-secondary">{ANALYZE_CARD_SUBTITLE}</p>

            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Date Range
              </label>
              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent hover:border-border-strong transition-all"
              >
                {DATE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="block text-sm font-medium text-text mb-2">Critique perspectives</span>
              <p className="text-xs text-text-secondary mb-2">
                Uncheck to limit which active lenses run. None selected uses all active perspectives.
              </p>
              <div className="flex flex-col gap-2 max-h-40 overflow-y-auto border border-border rounded-base p-3 bg-bg">
                {activePerspectiveRows.length === 0 ? (
                  <span className="text-sm text-text-secondary">Loading perspectives…</span>
                ) : (
                  activePerspectiveRows.map((p) => (
                    <label
                      key={p.slug}
                      className="flex items-center gap-2 text-sm text-text cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedPerspectiveSlugs.includes(p.slug)}
                        onChange={() => {
                          setSelectedPerspectiveSlugs((prev) =>
                            prev.includes(p.slug)
                              ? prev.filter((s) => s !== p.slug)
                              : [...prev, p.slug].sort((a, b) => a.localeCompare(b)),
                          );
                        }}
                        className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
                      />
                      <span>
                        {p.display_name} <span className="text-text-secondary">({p.slug})</span>
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-text mb-2">
                Minimum rating (catalog)
              </label>
              <select
                value={batchMinRating === null ? '' : String(batchMinRating)}
                onChange={(e) => {
                  const v = e.target.value;
                  setBatchMinRating(v === '' ? null : Number(v));
                }}
                className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent hover:border-border-strong transition-all"
              >
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}+ stars
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-text-secondary">
                Applies to catalog images in the selected date range.
              </p>
            </div>

            <div>
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="force-recull"
                  checked={forceCull}
                  onChange={(e) => setForceCull(e.target.checked)}
                  className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
                />
                <label htmlFor="force-recull" className="text-sm text-text cursor-pointer">
                  {ANALYZE_FORCE_CULL_LABEL}
                </label>
              </div>
              {forceCull && <p className="mt-1.5 ml-6 text-xs text-warning">{ANALYZE_FORCE_CULL_HINT}</p>}
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="force-regenerate-describe"
                checked={forceDescribe}
                disabled={backfillVisualTags}
                onChange={(e) => handleForceDescribeChange(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 disabled:opacity-50"
              />
              <label
                htmlFor="force-regenerate-describe"
                className={`text-sm ${backfillVisualTags ? 'text-text-secondary' : 'text-text cursor-pointer'}`}
              >
                {ANALYZE_FORCE_DESCRIBE_LABEL}
              </label>
            </div>

            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="force-regenerate-score"
                checked={forceScore}
                disabled={backfillVisualTags}
                onChange={(e) => handleForceScoreChange(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 disabled:opacity-50"
              />
              <label
                htmlFor="force-regenerate-score"
                className={`text-sm ${backfillVisualTags ? 'text-text-secondary' : 'text-text cursor-pointer'}`}
              >
                {ANALYZE_FORCE_SCORE_LABEL}
              </label>
            </div>

            {backfillVisualTags && (
              <p className="text-xs text-text-secondary -mt-2">
                {ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT}
              </p>
            )}

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center space-x-2 text-sm font-medium text-accent hover:text-accent-hover transition-colors"
              >
                <svg
                  className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                <span>{ADVANCED_OPTIONS_TITLE}</span>
              </button>
            </div>

            {showAdvanced && (
              <div className="pt-4 border-t border-border space-y-4">
                <ProviderModelSelect
                  providerId={descProviderId}
                  modelId={descProviderModel}
                  onChange={(providerId, modelId) => {
                    setDescProviderId(providerId);
                    setDescProviderModel(modelId);
                  }}
                />
                <WorkerSlider value={options.maxWorkers} onChange={(v) => updateOption('maxWorkers', v)} />

                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="backfill-visual-tags"
                    checked={backfillVisualTags}
                    disabled={forceDescribe || forceScore}
                    onChange={(e) => handleBackfillVisualTagsChange(e.target.checked)}
                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 disabled:opacity-50"
                  />
                  <label
                    htmlFor="backfill-visual-tags"
                    className={`text-sm ${forceDescribe || forceScore ? 'text-text-secondary' : 'text-text cursor-pointer'}`}
                  >
                    {ANALYZE_BACKFILL_VISUAL_TAGS_LABEL}
                  </label>
                </div>

                {(forceDescribe || forceScore) && (
                  <p className="text-xs text-text-secondary -mt-2">
                    {ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT}
                  </p>
                )}

                <div className="pt-4 border-t border-border space-y-3">
                  <h3 className="text-sm font-semibold text-text">
                    {ANALYZE_ADVANCED_RUN_SEPARATELY_TITLE}
                  </h3>
                  <Button
                    variant="secondary"
                    size="md"
                    fullWidth
                    onClick={startDescriptionsOnly}
                    disabled={isAnySubmitting}
                  >
                    {isStartingDescribe
                      ? startingLabel
                      : ANALYZE_ADVANCED_DESCRIBE_ONLY}
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    fullWidth
                    onClick={startScoringOnly}
                    disabled={isAnySubmitting}
                  >
                    {isStartingScore
                      ? startingLabel
                      : ANALYZE_ADVANCED_SCORE_ONLY}
                  </Button>
                </div>
              </div>
            )}

            <div className="pt-4 space-y-3">
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onClick={startAnalyze}
                disabled={isAnySubmitting}
              >
                {isStartingAnalyze ? startingLabel : ANALYZE_PRIMARY_BUTTON}
              </Button>
              {statusBanner && (
                <div
                  role={statusBanner.tone === 'error' ? 'alert' : 'status'}
                  aria-live="polite"
                  data-testid="analyze-status-banner"
                  data-tone={statusBanner.tone}
                  className={
                    statusBanner.tone === 'success'
                      ? 'flex items-start justify-between gap-3 px-4 py-3 rounded-base border border-green-500/40 bg-green-500/10 text-sm text-text'
                      : 'flex items-start justify-between gap-3 px-4 py-3 rounded-base border border-red-500/40 bg-red-500/10 text-sm text-text'
                  }
                >
                  <div className="flex-1">
                    <p>{statusBanner.message}</p>
                    {statusBanner.jobId && (
                      <p className="mt-1 text-xs text-text-secondary">
                        Job id: <span className="font-mono">{statusBanner.jobId.slice(0, 8)}</span>
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setStatusBanner(null)}
                    className="text-text-secondary hover:text-text text-xs underline"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      {cullingDialog}
    </div>
  );
}
