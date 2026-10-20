import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ImagesAPI, PerspectivesAPI, type CatalogImage } from '../../services/api';
import { ImageDetailModal, ImageTile, fromCatalogListRow } from '../image-view';
import { Pagination } from '../ui/Pagination';
import { TileGrid } from '../ui/TileGrid';
import { useQuery } from '../../data';
import {
  FILTER_ALL_DATES,
  CATALOG_FILTER_LABEL_STATUS,
  CATALOG_FILTER_LABEL_ANALYZED,
  CATALOG_FILTER_LABEL_MONTH,
  CATALOG_FILTER_LABEL_KEYWORD,
  CATALOG_FILTER_LABEL_MIN_RATING,
  CATALOG_FILTER_LABEL_DATE_RANGE,
  CATALOG_FILTER_LABEL_COLOR,
  CATALOG_FILTER_LABEL_SCORE_PERSPECTIVE,
  CATALOG_FILTER_LABEL_MIN_SCORE,
  CATALOG_FILTER_LABEL_MIN_SCORE_ACTIVE,
  CATALOG_FILTER_LABEL_SORT_SCORE,
  FILTER_LABEL_SORT_DATE,
  FILTER_SORT_DATE_NEWEST,
  FILTER_SORT_DATE_OLDEST,
  CATALOG_FILTER_POSTED_ALL,
  CATALOG_FILTER_POSTED,
  CATALOG_FILTER_NOT_POSTED,
  CATALOG_FILTER_ANALYZED_ALL,
  CATALOG_FILTER_ANALYZED_ONLY,
  CATALOG_FILTER_NOT_ANALYZED,
  CATALOG_FILTER_MIN_RATING_ANY,
  CATALOG_FILTER_SCORE_ANY,
  CATALOG_FILTER_SORT_NONE,
  CATALOG_FILTER_SORT_HIGH_LOW,
  CATALOG_FILTER_SORT_LOW_HIGH,
  CATALOG_FILTER_KEYWORD_PLACEHOLDER,
  CATALOG_FILTER_KEYWORD_ARIA,
  FILTER_DESCRIPTION_SEARCH_LABEL,
  FILTER_DESCRIPTION_SEARCH_PLACEHOLDER,
  FILTER_DESCRIPTION_SEARCH_ARIA,
  CATALOG_FILTER_COLOR_PLACEHOLDER,
  CATALOG_FILTER_COLOR_ARIA,
  msgShowingOf,
  INSIGHTS_KPI_BURST_STACKS,
  CATALOG_FILTER_LABEL_FRAME_SUBSTANCE,
  CATALOG_FILTER_FRAME_SUBSTANCE_ONLY,
} from '../../constants/strings';
import { formatMonth } from '../../utils/date';
import { useFilters } from '../../hooks/useFilters';
import { FilterBar } from '../filters/FilterBar';
import type { FilterSchema } from '../filters/types';
import { FILTER_PERSIST_KEYS } from '../../stores/pageUiStore';
import { stableSerializeRecord } from '../../utils/stableQueryKey';

const LIMIT = 50;

/** Row-data we need to open the consolidated modal — only type + key are
 *  required (detail endpoint fills the rest); the full row is kept so the
 *  header can render instantly while the detail request is in flight. */
type SelectedCatalogEntry = {
  key: string;
  initial?: CatalogImage;
};

type CatalogTabProps = {
  /** Fires when the posted / not-posted filter changes (for parent UI, e.g. Analytics cross-link). */
  onPostedFilterChange?: (posted: boolean | undefined) => void;
  /** Images → Cull catalog: passed + sent-by-hand only. */
  cullCatalog?: boolean;
};

export function CatalogTab({ onPostedFilterChange, cullCatalog = false }: CatalogTabProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<SelectedCatalogEntry | null>(null);

  const monthsPayload = useQuery(['images.catalog', 'months'] as const, () =>
    ImagesAPI.getCatalogMonths(),
  );
  const availableMonths = monthsPayload.months;

  const perspectivesRows = useQuery(['perspectives', 'list', 'active'] as const, () =>
    PerspectivesAPI.list({ active_only: true }),
  );
  const scorePerspectives = useMemo(() => {
    const sorted = [...perspectivesRows].sort((a, b) => a.slug.localeCompare(b.slug));
    return sorted.map((r) => ({ slug: r.slug, display_name: r.display_name }));
  }, [perspectivesRows]);

  const catalogSchema = useMemo<FilterSchema>(() => {
    return [
      {
        type: 'toggle',
        key: 'posted',
        label: CATALOG_FILTER_LABEL_STATUS,
        options: [
          { value: undefined, label: CATALOG_FILTER_POSTED_ALL },
          { value: true, label: CATALOG_FILTER_POSTED },
          { value: false, label: CATALOG_FILTER_NOT_POSTED },
        ],
      },
      {
        type: 'toggle',
        key: 'analyzed',
        label: CATALOG_FILTER_LABEL_ANALYZED,
        options: [
          { value: undefined, label: CATALOG_FILTER_ANALYZED_ALL },
          { value: true, label: CATALOG_FILTER_ANALYZED_ONLY },
          { value: false, label: CATALOG_FILTER_NOT_ANALYZED },
        ],
      },
      ...(availableMonths.length > 0
        ? ([
            {
              type: 'select',
              key: 'month',
              label: CATALOG_FILTER_LABEL_MONTH,
              options: [
                { value: '', label: FILTER_ALL_DATES },
                ...availableMonths.map((m) => ({ value: m, label: formatMonth(m) })),
              ],
            },
          ] as FilterSchema)
        : []),
      {
        type: 'search',
        key: 'keyword',
        label: CATALOG_FILTER_LABEL_KEYWORD,
        debounceMs: 350,
        placeholder: CATALOG_FILTER_KEYWORD_PLACEHOLDER,
        ariaLabel: CATALOG_FILTER_KEYWORD_ARIA,
        className: 'h-9 min-w-[8rem] w-36',
      },
      {
        type: 'search',
        key: 'descriptionSearch',
        label: FILTER_DESCRIPTION_SEARCH_LABEL,
        paramName: 'description_search',
        debounceMs: 350,
        placeholder: FILTER_DESCRIPTION_SEARCH_PLACEHOLDER,
        ariaLabel: FILTER_DESCRIPTION_SEARCH_ARIA,
        className: 'h-9 min-w-[10rem] w-44',
      },
      {
        type: 'select',
        key: 'minRating',
        label: CATALOG_FILTER_LABEL_MIN_RATING,
        paramName: 'min_rating',
        numberValue: true,
        options: [
          { value: '', label: CATALOG_FILTER_MIN_RATING_ANY },
          ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: '★'.repeat(n) })),
        ],
      },
      {
        type: 'dateRange',
        key: 'dateRange',
        label: CATALOG_FILTER_LABEL_DATE_RANGE,
        chipLabel: CATALOG_FILTER_LABEL_DATE_RANGE,
      },
      {
        type: 'search',
        key: 'colorLabel',
        label: CATALOG_FILTER_LABEL_COLOR,
        paramName: 'color_label',
        debounceMs: 350,
        placeholder: CATALOG_FILTER_COLOR_PLACEHOLDER,
        ariaLabel: CATALOG_FILTER_COLOR_ARIA,
        className: 'h-9 min-w-[6rem] w-28',
      },
      {
        type: 'select',
        key: 'scorePerspective',
        label: CATALOG_FILTER_LABEL_SCORE_PERSPECTIVE,
        className: 'min-w-[8rem]',
        options: [
          { value: '', label: CATALOG_FILTER_SCORE_ANY },
          ...scorePerspectives.map((p) => ({ value: p.slug, label: p.display_name })),
        ],
      },
      {
        type: 'select',
        key: 'minCatalogScore',
        label: CATALOG_FILTER_LABEL_MIN_SCORE,
        paramName: 'min_score',
        numberValue: true,
        options: [
          { value: '', label: CATALOG_FILTER_SCORE_ANY },
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
            value: String(n),
            label: `${n}+`,
          })),
        ],
        enabledBy: { filterKey: 'scorePerspective', when: (v) => Boolean(v) },
      },
      {
        type: 'select',
        key: 'sortByScore',
        label: CATALOG_FILTER_LABEL_SORT_SCORE,
        paramName: 'sort_by_score',
        defaultValue: 'none',
        options: [
          { value: 'none', label: CATALOG_FILTER_SORT_NONE },
          { value: 'desc', label: CATALOG_FILTER_SORT_HIGH_LOW },
          { value: 'asc', label: CATALOG_FILTER_SORT_LOW_HIGH },
        ],
        enabledBy: { filterKey: 'scorePerspective', when: (v) => Boolean(v) },
        toParam: (v) => (v === 'none' || v === '' || v === undefined ? undefined : v),
      },
      {
        type: 'select',
        key: 'sortByDate',
        label: FILTER_LABEL_SORT_DATE,
        paramName: 'sort_by_date',
        defaultValue: 'newest',
        options: [
          { value: 'newest', label: FILTER_SORT_DATE_NEWEST },
          { value: 'oldest', label: FILTER_SORT_DATE_OLDEST },
        ],
      },
      {
        type: 'select',
        key: 'minScoreOnActive',
        label: CATALOG_FILTER_LABEL_MIN_SCORE_ACTIVE,
        paramName: 'min_score_on_active',
        numberValue: true,
        options: [
          { value: '', label: CATALOG_FILTER_SCORE_ANY },
          ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
            value: String(n),
            label: `${n}+`,
          })),
        ],
      },
      {
        type: 'toggle',
        key: 'burstStack',
        label: INSIGHTS_KPI_BURST_STACKS,
        paramName: 'burst_stack',
        options: [
          { value: undefined, label: CATALOG_FILTER_POSTED_ALL },
          { value: true, label: INSIGHTS_KPI_BURST_STACKS },
        ],
      },
      {
        type: 'toggle',
        key: 'flagged',
        label: CATALOG_FILTER_LABEL_FRAME_SUBSTANCE,
        options: [
          { value: undefined, label: CATALOG_FILTER_POSTED_ALL },
          { value: true, label: CATALOG_FILTER_FRAME_SUBSTANCE_ONLY },
        ],
      },
    ];
  }, [availableMonths, scorePerspectives]);

  const filters = useFilters(catalogSchema, { persistKey: FILTER_PERSIST_KEYS.imagesCatalog });
  const { values: filterValues, rawValues: filterRawValues, toQueryParams, activeCount, setValues } = filters;

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const patch: Record<string, unknown> = {};
    const minScoreOnActive = sp.get('min_score_on_active');
    if (minScoreOnActive) patch.minScoreOnActive = minScoreOnActive;
    if (sp.get('burst_stack') === 'true') patch.burstStack = true;
    if (sp.get('flagged') === 'true') patch.flagged = true;
    if (Object.keys(patch).length > 0) setValues(patch);
  }, [location.search, setValues]);

  const listParams = useMemo(
    () => ({
      ...toQueryParams(),
      limit: LIMIT,
      offset: (page - 1) * LIMIT,
      ...(cullCatalog ? { cull_catalog: true as const } : {}),
    }),
    [page, toQueryParams, cullCatalog],
  );

  const listQueryKey = useMemo(
    () => ['images.catalog', 'list', stableSerializeRecord(listParams)] as const,
    [listParams],
  );

  const catalogPage = useQuery(listQueryKey, () => ImagesAPI.listCatalog(listParams));
  const images = catalogPage.images;
  const total = catalogPage.total;

  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const raw = sp.get('image_key');
    if (!raw) return;
    setSelected({ key: raw });
    sp.delete('image_key');
    const next = sp.toString();
    navigate({ pathname: location.pathname, search: next ? `?${next}` : '' }, { replace: true });
  }, [location.search, location.pathname, navigate]);

  const postedCommitted = filterValues.posted as boolean | undefined;
  useEffect(() => {
    onPostedFilterChange?.(postedCommitted);
  }, [postedCommitted, onPostedFilterChange]);

  // D-10: non-search filter changes reset page to 1 immediately.
  useEffect(() => {
    startTransition(() => setPage(1));
  }, [
    filterValues.posted,
    filterValues.analyzed,
    filterValues.month,
    filterValues.minRating,
    filterValues.dateRange,
    filterValues.scorePerspective,
    filterValues.minCatalogScore,
    filterValues.minScoreOnActive,
    filterValues.burstStack,
    filterValues.flagged,
    filterValues.sortByScore,
    filterValues.sortByDate,
  ]);

  // Debounced text parity with legacy lines 255–264: reset page on committed keyword / colorLabel change.
  const prevKeyword = useRef(filterValues.keyword);
  const prevColor = useRef(filterValues.colorLabel);
  const prevDescriptionSearch = useRef(filterValues.descriptionSearch);
  useEffect(() => {
    if (
      prevKeyword.current !== filterValues.keyword ||
      prevColor.current !== filterValues.colorLabel ||
      prevDescriptionSearch.current !== filterValues.descriptionSearch
    ) {
      prevKeyword.current = filterValues.keyword;
      prevColor.current = filterValues.colorLabel;
      prevDescriptionSearch.current = filterValues.descriptionSearch;
      startTransition(() => setPage(1));
    }
  }, [filterValues.keyword, filterValues.colorLabel, filterValues.descriptionSearch]);

  const hasActiveFilters = activeCount > 0;

  const noFiltersAndEmptyDb = total === 0 && !hasActiveFilters;

  const totalPages = Math.ceil(total / LIMIT);

  const summaryText = (() => {
    if (total === 0 && hasActiveFilters) {
      return 'No images match the filters';
    }
    return msgShowingOf(images.length, total, 'images');
  })();

  // Silence unused-var warning for rawValues destructure — kept for future debug / UAT.
  void filterRawValues;

  return (
    <div className="space-y-6">
      <FilterBar
        schema={catalogSchema}
        filters={filters}
        summary={<p className="text-sm text-text-secondary">{summaryText}</p>}
        disabled={false}
      />

      {noFiltersAndEmptyDb ? (
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
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-text">No Catalog Images</h3>
          <p className="mt-1 text-sm text-text-secondary">
            Your catalog database is empty or not yet indexed.
          </p>
        </div>
      ) : total === 0 && hasActiveFilters ? (
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
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-text">No Images Found</h3>
          <p className="mt-1 text-sm text-text-secondary">Try changing or clearing the filters.</p>
        </div>
      ) : (
        <>
          <div className={`relative transition-opacity duration-150${isPending ? ' opacity-50 pointer-events-none' : ''}`}>
            <TileGrid>
              {images.map((image) => (
                <ImageTile
                  key={image.id != null ? String(image.id) : image.key}
                  image={fromCatalogListRow(image)}
                  variant="grid"
                  primaryScoreSource="catalog"
                  onClick={() => setSelected({ key: image.key, initial: image })}
                />
              ))}
            </TileGrid>
          </div>

          {totalPages > 1 && (
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              onPageChange={(p) => startTransition(() => setPage(p))}
            />
          )}
        </>
      )}

      {selected && (
        <ImageDetailModal
          imageType="catalog"
          imageKey={selected.key}
          initialImage={selected.initial ? fromCatalogListRow(selected.initial) : undefined}
          primaryScoreSource="catalog"
          scorePerspectiveSlug={
            typeof filterValues.scorePerspective === 'string' && filterValues.scorePerspective
              ? filterValues.scorePerspective
              : undefined
          }
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
