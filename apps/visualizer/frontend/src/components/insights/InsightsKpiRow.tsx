import { Link } from 'react-router-dom'
import type { InsightsSummary } from '../../services/api'
import { Badge } from '../ui/badges'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card'
import {
  DASHBOARD_CATALOG_IMAGES,
  INSIGHTS_KPI_BURST_STACKS,
  INSIGHTS_KPI_BURST_STACKS_DESC,
  INSIGHTS_KPI_CATALOG_DESC,
  INSIGHTS_KPI_CATALOG_DESC_FOLDER,
  INSIGHTS_KPI_SCORING_9_PLUS,
  INSIGHTS_KPI_SCORING_9_PLUS_DESC,
  INSIGHTS_KPI_UNSCORED_ACTIVE,
  INSIGHTS_KPI_UNSCORED_ACTIVE_DESC,
  INSIGHTS_LINK_BURST_STACKS,
  INSIGHTS_LINK_CATALOG,
  INSIGHTS_LINK_SCORE_JOB,
  INSIGHTS_LINK_SCORING_9_PLUS,
  MSG_LOADING,
} from '../../constants/strings'
import { forCatalogKind } from '../../utils/catalogKindCopy'

export type InsightsKpiRowProps = {
  summary: InsightsSummary | null
  loading: boolean
  error: string | null
  catalogKind?: 'lightroom' | 'folder'
}

type StatBadge = 'default' | 'success' | 'accent' | 'warning'

export function InsightsKpiRow({
  summary,
  loading,
  error,
  catalogKind = 'lightroom',
}: InsightsKpiRowProps) {
  if (error) {
    return (
      <div className="rounded-card border border-border bg-surface px-4 py-3 text-sm text-error" role="alert">
        {error}
      </div>
    )
  }

  if (loading) {
    return (
      <p className="text-sm text-text-secondary" role="status" aria-live="polite">
        {MSG_LOADING}
      </p>
    )
  }

  const catalog = summary?.catalog_images ?? 0
  const scoring9 = summary?.scoring_9_plus ?? 0
  const burstStacks = summary?.burst_stacks ?? 0
  const unscoredActive = summary?.unscored_on_active_perspectives ?? 0

  const cards: Array<{
    title: string
    value: string
    description: string
    link: string
    badge: StatBadge
  }> = [
    {
      title: DASHBOARD_CATALOG_IMAGES,
      value: catalog.toLocaleString(),
      description: forCatalogKind(
        catalogKind,
        INSIGHTS_KPI_CATALOG_DESC,
        INSIGHTS_KPI_CATALOG_DESC_FOLDER,
      ),
      link: INSIGHTS_LINK_CATALOG,
      badge: catalog > 0 ? 'success' : 'default',
    },
    {
      title: INSIGHTS_KPI_SCORING_9_PLUS,
      value: scoring9.toLocaleString(),
      description: INSIGHTS_KPI_SCORING_9_PLUS_DESC,
      link: INSIGHTS_LINK_SCORING_9_PLUS,
      badge: scoring9 > 0 ? 'success' : 'default',
    },
    {
      title: INSIGHTS_KPI_BURST_STACKS,
      value: burstStacks.toLocaleString(),
      description: INSIGHTS_KPI_BURST_STACKS_DESC,
      link: INSIGHTS_LINK_BURST_STACKS,
      badge: burstStacks > 0 ? 'accent' : 'default',
    },
    {
      title: INSIGHTS_KPI_UNSCORED_ACTIVE,
      value: unscoredActive.toLocaleString(),
      description: INSIGHTS_KPI_UNSCORED_ACTIVE_DESC,
      link: INSIGHTS_LINK_SCORE_JOB,
      badge: unscoredActive > 0 ? 'warning' : 'default',
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((stat) => (
        <Link key={stat.title} to={stat.link}>
          <Card hoverable padding="md">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm leading-snug">{stat.title}</CardTitle>
                <Badge variant={stat.badge}>{stat.value}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-text-secondary">{stat.description}</p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  )
}
