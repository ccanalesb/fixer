import { useState, type ReactNode } from 'react'
import {
  IdentityAPI,
  type MirrorExemplar,
  type MirrorOtherLens,
  type MirrorResponse,
  type MirrorTechniqueSection,
} from '../../services/api'
import { useQuery } from '../../data'
import { keys } from '../../data/keys'
import { Card, CardContent } from '../ui/Card'
import { ImageDetailModal, modalPropsFor } from '../image-view'
import {
  IDENTITY_MIRROR_EMPTY,
  IDENTITY_MIRROR_INTRO,
  IDENTITY_MIRROR_LOW_COVERAGE,
  IDENTITY_MIRROR_OTHER_LENSES,
  IDENTITY_MIRROR_OTHER_LENSES_SUMMARY,
  IDENTITY_MIRROR_SECTION,
  IDENTITY_MIRROR_STANDOUT,
  IDENTITY_MIRROR_WHY_HERE,
} from '../../constants/strings'
import { ExemplarRail } from './ExemplarRail'

function formatStatTooltip(section: Pick<MirrorTechniqueSection, 'win_rate' | 'chance_rate' | 'z_score'>): string {
  const wr = Math.round(section.win_rate * 100)
  const chance = Math.round(section.chance_rate * 100)
  return `wins ${wr}% of contests vs ~${chance}% by chance · z=${section.z_score}`
}

function MirrorStandoutContext({
  section,
  exemplar,
}: {
  section: Pick<MirrorTechniqueSection, 'display_name' | 'win_rate' | 'chance_rate' | 'z_score'>
  exemplar: MirrorExemplar
}) {
  return (
    <div className="rounded-base border border-accent/40 bg-bg p-3">
      <p className="text-[11px] uppercase tracking-wider text-accent">{IDENTITY_MIRROR_STANDOUT}</p>
      <p className="mt-1 text-base font-semibold text-text">
        {section.display_name} — {exemplar.percentile}th percentile
      </p>
      <p className="mt-2 text-sm text-text-secondary">
        Ranks in the top {(100 - exemplar.percentile).toFixed(1)}% of your catalog on this lens
        {exemplar.purity > 0
          ? `, and leads its own next-strongest lens by ${exemplar.purity} points (distinctive, not just generally strong).`
          : '.'}
      </p>
      <p className="mt-2 text-xs text-text-tertiary">{formatStatTooltip(section)}</p>
    </div>
  )
}

function TechniqueBlock({
  section,
  onOpenExemplar,
  pageSize,
  initialLimit,
}: {
  section: MirrorTechniqueSection
  onOpenExemplar: (exemplar: MirrorExemplar, index: number, exemplars: MirrorExemplar[]) => void
  pageSize?: number
  initialLimit?: number
}) {
  return (
    <section className="space-y-3" aria-labelledby={`mirror-tech-${section.perspective_slug}`}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 id={`mirror-tech-${section.perspective_slug}`} className="text-xl font-semibold text-text">
          {section.display_name}
        </h3>
        <span
          className={`cursor-help border-b border-dotted text-sm font-semibold ${
            section.leading_not_distinctive
              ? 'border-border text-text-secondary'
              : 'border-accent/50 text-accent'
          }`}
          title={formatStatTooltip(section)}
          tabIndex={0}
        >
          {section.strength_label}
        </span>
        {section.low_coverage ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">
            {IDENTITY_MIRROR_LOW_COVERAGE.replace('{pct}', String(Math.round(section.coverage * 100)))}
          </span>
        ) : null}
      </div>

      {section.leading_not_distinctive ? (
        <p className="text-sm text-text-tertiary">
          No technique clears the bar for a distinctive signature — your strengths are fairly even. This is
          simply your leading lens.
        </p>
      ) : null}

      {section.descriptors.length > 0 ? (
        <ul className="flex flex-wrap gap-2 text-xs">
          {section.descriptors.map((d) => (
            <li
              key={d.token}
              className="rounded-full border border-border bg-bg px-2 py-0.5 text-text-secondary"
            >
              <span className="font-medium text-text">{d.token}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ExemplarRail
        perspectiveSlug={section.perspective_slug}
        initialItems={section.exemplars}
        initialTotal={section.exemplar_total}
        onOpenExemplar={onOpenExemplar}
        pageSize={pageSize}
        initialLimit={initialLimit}
      />
    </section>
  )
}

function OtherLensRow({
  lens,
  onOpenExemplar,
  pageSize,
  initialLimit,
}: {
  lens: MirrorOtherLens
  onOpenExemplar: (exemplar: MirrorExemplar, index: number, exemplars: MirrorExemplar[]) => void
  pageSize?: number
  initialLimit?: number
}) {
  return (
    <details className="rounded-base border border-border bg-bg">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-3 px-4 py-3 marker:content-none">
        <span className="text-base font-semibold text-text">{lens.display_name}</span>
        <span
          className="cursor-help border-b border-dotted border-border text-sm font-semibold text-text-secondary"
          title={formatStatTooltip(lens)}
          tabIndex={0}
        >
          {lens.strength_label}
        </span>
        <span className="text-xs text-text-tertiary">
          {Math.round(lens.coverage * 100)}% catalog coverage
        </span>
        {lens.low_coverage ? (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">
            {IDENTITY_MIRROR_LOW_COVERAGE.replace('{pct}', String(Math.round(lens.coverage * 100)))}
          </span>
        ) : null}
      </summary>
      <div className="border-t border-border px-4 pb-4 pt-2">
        <ExemplarRail
          perspectiveSlug={lens.perspective_slug}
          initialTotal={lens.exemplar_total}
          onOpenExemplar={onOpenExemplar}
          pageSize={pageSize}
          initialLimit={initialLimit}
        />
      </div>
    </details>
  )
}

function MirrorContent({ data }: { data: MirrorResponse }) {
  const [modal, setModal] = useState<{
    section: Pick<MirrorTechniqueSection, 'perspective_slug' | 'display_name' | 'win_rate' | 'chance_rate' | 'z_score'>
    exemplars: MirrorExemplar[]
    navIndex: number
  } | null>(null)

  if (data.sections.length === 0) {
    return (
      <p className="text-sm text-text-secondary" role="status">
        {IDENTITY_MIRROR_EMPTY}
      </p>
    )
  }

  function openFromSection(
    section: MirrorTechniqueSection | MirrorOtherLens,
    index: number,
    exemplars: MirrorExemplar[],
  ) {
    setModal({
      section: {
        perspective_slug: section.perspective_slug,
        display_name: section.display_name,
        win_rate: section.win_rate,
        chance_rate: section.chance_rate,
        z_score: section.z_score,
      },
      exemplars,
      navIndex: index,
    })
  }

  let contextSlot: ReactNode = null
  if (modal) {
    const exemplar = modal.exemplars[modal.navIndex] ?? modal.exemplars[0]
    contextSlot = (
      <div>
        <h3 className="mb-3 text-lg font-semibold text-text">{IDENTITY_MIRROR_WHY_HERE}</h3>
        <MirrorStandoutContext section={modal.section} exemplar={exemplar} />
      </div>
    )
  }

  const exemplarPageSize = data.meta?.exemplar_page_size ?? undefined
  const exemplarInitialLimit = data.meta?.exemplar_initial_limit ?? undefined

  return (
    <>
      <p className="text-sm text-text-secondary">
        {IDENTITY_MIRROR_INTRO.replace('{count}', String(data.population))}
      </p>
      <div className="space-y-10">
        {data.sections.map((section) => (
          <TechniqueBlock
            key={section.perspective_slug}
            section={section}
            onOpenExemplar={(_exemplar, index, exemplars) =>
              openFromSection(section, index, exemplars)
            }
            pageSize={exemplarPageSize}
            initialLimit={exemplarInitialLimit}
          />
        ))}
      </div>

      {data.other_lenses.length > 0 ? (
        <details className="rounded-base border border-border">
          <summary className="cursor-pointer list-none px-4 py-3 marker:content-none">
            <h3 className="text-lg font-semibold text-text">{IDENTITY_MIRROR_OTHER_LENSES}</h3>
            <p className="mt-1 text-sm text-text-secondary">{IDENTITY_MIRROR_OTHER_LENSES_SUMMARY}</p>
          </summary>
          <div className="space-y-3 border-t border-border px-4 py-4">
            {data.other_lenses.map((lens) => (
              <OtherLensRow
                key={lens.perspective_slug}
                lens={lens}
                onOpenExemplar={(_exemplar, index, exemplars) =>
                  openFromSection(lens, index, exemplars)
                }
                pageSize={exemplarPageSize}
                initialLimit={exemplarInitialLimit}
              />
            ))}
          </div>
        </details>
      ) : null}

      {data.meta?.scores_are_advisory ? (
        <p className="text-xs text-text-tertiary">{data.meta.scores_are_advisory}</p>
      ) : null}

      {modal ? (
        <ImageDetailModal
          imageKey={
            modal.exemplars[modal.navIndex]?.image_key ?? modal.exemplars[0]?.image_key ?? ''
          }
          {...modalPropsFor('identity')}
          scorePerspectiveSlug={modal.section.perspective_slug}
          contextSlot={contextSlot}
          nav={
            modal.exemplars.length > 1
              ? {
                  keys: modal.exemplars.map((e) => e.image_key),
                  index: modal.navIndex,
                  onIndexChange: (index) => setModal((prev) => (prev ? { ...prev, navIndex: index } : prev)),
                }
              : undefined
          }
          onClose={() => setModal(null)}
        />
      ) : null}
    </>
  )
}

export function MirrorPanel() {
  const data = useQuery(keys.identity.mirror(), () => IdentityAPI.getMirror())

  return (
    <section className="space-y-3" aria-labelledby="identity-mirror-heading">
      <h2 id="identity-mirror-heading" className="text-card-title text-text">
        {IDENTITY_MIRROR_SECTION}
      </h2>
      <Card padding="md">
        <CardContent className="space-y-6 !text-text">
          <MirrorContent data={data} />
        </CardContent>
      </Card>
    </section>
  )
}
