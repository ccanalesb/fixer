import { Suspense, useMemo } from 'react'
import { FirstRunSetupScreen } from '../components/setup/FirstRunSetupScreen'
import { useFirstRunSetup } from '../hooks/useFirstRunSetup'
import type { FilterSchema } from '../components/filters/types'
import { InsightsActionCards } from '../components/insights/InsightsActionCards'
import { InsightsKpiRow } from '../components/insights/InsightsKpiRow'
import { InsightsQuickNav } from '../components/insights/InsightsQuickNav'
import { PerspectiveCoverageList } from '../components/insights/PerspectiveCoverageList'
import { TopPhotosStrip } from '../components/insights/TopPhotosStrip'
import { Card, CardContent } from '../components/ui/Card'
import { TabNav } from '../components/ui/Tabs'
import {
  IDENTITY_BEST_PHOTOS_EMPTY_FALLBACK,
  INSIGHTS_FOOTER_TIMEZONE,
  INSIGHTS_PAGE_SUBTITLE,
  INSIGHTS_PAGE_TITLE,
  INSIGHTS_SECTION_EXPLORE,
  INSIGHTS_SECTION_HIGHLIGHTS,
  INSIGHTS_SECTION_NEXT_ACTIONS,
  INSIGHTS_SECTION_PERSPECTIVE_COVERAGE,
  INSIGHTS_TOP_PHOTOS_REGION_ARIA,
  INSIGHTS_TOP_PHOTOS_TAB_ALL,
  INSIGHTS_TOP_PHOTOS_TAB_POSTED,
  INSIGHTS_TOP_PHOTOS_TAB_UNPOSTED,
} from '../constants/strings'
import { ErrorBoundary, ErrorState, useQuery } from '../data'
import { useFilters } from '../hooks/useFilters'
import {
  IdentityAPI,
  SystemAPI,
  type IdentityBestPhotoItem,
  type IdentityBestPhotosMeta,
  type InsightsSummary,
} from '../services/api'

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

type TopPhotosTabKey = 'unposted' | 'posted' | 'all'

type TopPhotosBucket = {
  items: IdentityBestPhotoItem[]
  total: number
  meta: IdentityBestPhotosMeta | null
  loading: boolean
  error: string | null
}

type DashboardBundle = {
  insights: InsightsSummary | null
  errInsights: string | null
  topPhotosByTab: Record<TopPhotosTabKey, TopPhotosBucket>
}

async function fetchDashboardBundle(): Promise<DashboardBundle> {
  const results = await Promise.allSettled([
    SystemAPI.insightsSummary(),
    IdentityAPI.getBestPhotos({ limit: 8, posted: false }),
    IdentityAPI.getBestPhotos({ limit: 8, posted: true }),
    IdentityAPI.getBestPhotos({ limit: 8 }),
  ])

  const [r0, r1, r2, r3] = results

  let insights: InsightsSummary | null = null
  let errInsights: string | null = null
  if (r0.status === 'fulfilled') {
    insights = r0.value
  } else {
    errInsights = errMessage(r0.reason)
  }

  const mapBest = (
    r: PromiseSettledResult<Awaited<ReturnType<typeof IdentityAPI.getBestPhotos>>>,
  ): TopPhotosBucket => {
    if (r.status === 'fulfilled') {
      return {
        items: r.value.items,
        total: r.value.total,
        meta: r.value.meta,
        loading: false,
        error: null,
      }
    }
    return {
      items: [],
      total: 0,
      meta: null,
      loading: false,
      error: errMessage(r.reason),
    }
  }

  const topPhotosByTab: Record<TopPhotosTabKey, TopPhotosBucket> = {
    unposted: mapBest(r1),
    posted: mapBest(r2),
    all: mapBest(r3),
  }

  return {
    insights,
    errInsights,
    topPhotosByTab,
  }
}

const dashboardSuspenseFallback = (
  <div className="rounded-card border border-border bg-surface p-8 text-center text-sm text-text-secondary">
    Loading…
  </div>
)

function DashboardPageInner() {
  const firstRun = useFirstRunSetup()

  if (firstRun.showInsightsSetup) {
    if (firstRun.loading) {
      return dashboardSuspenseFallback
    }
    return <FirstRunSetupScreen setup={firstRun} />
  }

  return <DashboardInsightsView />
}

function DashboardInsightsView() {
  const dashboardTopPhotosSchema = useMemo<FilterSchema>(
    () => [
      {
        type: 'select',
        key: 'topPhotosPosted',
        label: INSIGHTS_TOP_PHOTOS_REGION_ARIA,
        paramName: 'posted',
        defaultValue: 'unposted',
        options: [
          { value: 'unposted', label: INSIGHTS_TOP_PHOTOS_TAB_UNPOSTED },
          { value: 'posted', label: INSIGHTS_TOP_PHOTOS_TAB_POSTED },
          { value: 'all', label: INSIGHTS_TOP_PHOTOS_TAB_ALL },
        ],
        toParam: (v) => (v === 'unposted' ? false : v === 'posted' ? true : undefined),
      },
    ],
    [],
  )

  const filters = useFilters(dashboardTopPhotosSchema)

  const bundle = useQuery(['dashboard'] as const, () => fetchDashboardBundle())

  const { insights, errInsights, topPhotosByTab } = bundle

  const loadingInsights = false

  const rawTopPhotosPosted = filters.values.topPhotosPosted as string | undefined
  const activeTopPhotosTab: TopPhotosTabKey =
    rawTopPhotosPosted === 'posted'
      ? 'posted'
      : rawTopPhotosPosted === 'all'
        ? 'all'
        : 'unposted'

  const activeTopPhotos = topPhotosByTab[activeTopPhotosTab]
  const bestEmptyMessage =
    !activeTopPhotos.loading &&
    !activeTopPhotos.error &&
    activeTopPhotos.total === 0
      ? activeTopPhotos.meta?.coverage_note ?? IDENTITY_BEST_PHOTOS_EMPTY_FALLBACK
      : null

  const a11yErrors = [
    errInsights && `Insights: ${errInsights}`,
    topPhotosByTab.unposted.error && `Best photos (unposted): ${topPhotosByTab.unposted.error}`,
    topPhotosByTab.posted.error && `Best photos (posted): ${topPhotosByTab.posted.error}`,
    topPhotosByTab.all.error && `Best photos (all): ${topPhotosByTab.all.error}`,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-section text-text mb-2">{INSIGHTS_PAGE_TITLE}</h1>
        <p className="text-text-secondary">{INSIGHTS_PAGE_SUBTITLE}</p>
      </div>

      <InsightsKpiRow
        summary={insights}
        loading={loadingInsights}
        error={errInsights}
      />

      {a11yErrors ? (
        <p className="sr-only" role="status" aria-live="polite">
          {a11yErrors}
        </p>
      ) : null}

      <section className="space-y-3" aria-labelledby="insights-highlights-heading">
        <h2 id="insights-highlights-heading" className="text-card-title text-text">
          {INSIGHTS_SECTION_HIGHLIGHTS}
        </h2>
        <Card padding="md">
          <CardContent className="!text-text">
            <div role="region" aria-label={INSIGHTS_TOP_PHOTOS_REGION_ARIA}>
              <TabNav
                tabs={[
                  { id: 'unposted', label: INSIGHTS_TOP_PHOTOS_TAB_UNPOSTED },
                  { id: 'posted', label: INSIGHTS_TOP_PHOTOS_TAB_POSTED },
                  { id: 'all', label: INSIGHTS_TOP_PHOTOS_TAB_ALL },
                ]}
                activeTab={activeTopPhotosTab}
                onTabChange={(id) => filters.setValue('topPhotosPosted', id)}
              />
              <TopPhotosStrip
                items={activeTopPhotos.items}
                loading={activeTopPhotos.loading}
                error={activeTopPhotos.error}
                emptyMessage={bestEmptyMessage}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3" aria-labelledby="insights-next-actions-heading">
        <h2 id="insights-next-actions-heading" className="text-card-title text-text">
          {INSIGHTS_SECTION_NEXT_ACTIONS}
        </h2>
        <InsightsActionCards summary={insights} />
      </section>

      <section className="space-y-3" aria-labelledby="insights-coverage-heading">
        <h2 id="insights-coverage-heading" className="text-card-title text-text">
          {INSIGHTS_SECTION_PERSPECTIVE_COVERAGE}
        </h2>
        <PerspectiveCoverageList
          rows={insights?.perspective_coverage ?? []}
          catalogImages={insights?.catalog_images ?? 0}
        />
      </section>

      <section className="space-y-3" aria-labelledby="insights-explore-heading">
        <h2 id="insights-explore-heading" className="text-card-title text-text">
          {INSIGHTS_SECTION_EXPLORE}
        </h2>
        <InsightsQuickNav />
      </section>

      <footer className="border-t border-border pt-6 text-xs text-text-tertiary">
        <p>{INSIGHTS_FOOTER_TIMEZONE}</p>
      </footer>
    </div>
  )
}

export function DashboardPage() {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <ErrorState error={error} reset={reset} title="Could not load dashboard" />
      )}
    >
      <Suspense fallback={dashboardSuspenseFallback}>
        <DashboardPageInner />
      </Suspense>
    </ErrorBoundary>
  )
}
