import { Suspense } from 'react'
import { AdvisorPanel } from '../components/identity/AdvisorPanel'
import { MirrorPanel } from '../components/identity/MirrorPanel'
import { LibraryEmptyPrompt } from '../components/setup/LibraryEmptyPrompt'
import { SkeletonGrid } from '../components/ui/page-states'
import {
  FIRST_RUN_IDENTITY_EMPTY_HINT,
  IDENTITY_DIVIDER_BACKWARD,
  IDENTITY_DIVIDER_FORWARD,
  IDENTITY_PAGE_SUBTITLE,
  IDENTITY_PAGE_TITLE,
} from '../constants/strings'
import { ErrorBoundary, ErrorState, invalidate, invalidateAll } from '../data'
import { useFirstRunSetup } from '../hooks/useFirstRunSetup'

function IdentityPageBody() {
  const firstRun = useFirstRunSetup()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-section text-text mb-2">{IDENTITY_PAGE_TITLE}</h1>
        <p className="text-text-secondary">{IDENTITY_PAGE_SUBTITLE}</p>
      </div>

      {firstRun.showIdentityEmpty ? (
        <LibraryEmptyPrompt hint={FIRST_RUN_IDENTITY_EMPTY_HINT} />
      ) : (
        <>
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <ErrorState
            error={error}
            reset={() => {
              invalidate(['identity', 'mirror'])
              reset()
            }}
          />
        )}
      >
        <Suspense fallback={<SkeletonGrid count={6} />}>
          <MirrorPanel />
        </Suspense>
      </ErrorBoundary>

      <div
        className="flex items-center gap-4 pt-2 text-sm text-text-secondary"
        role="separator"
        aria-label={`${IDENTITY_DIVIDER_BACKWARD} — ${IDENTITY_DIVIDER_FORWARD}`}
      >
        <span className="shrink-0 font-medium text-text">{IDENTITY_DIVIDER_BACKWARD}</span>
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span className="shrink-0 font-medium text-text">{IDENTITY_DIVIDER_FORWARD}</span>
      </div>

      <ErrorBoundary
        fallback={({ error, reset }) => (
          <ErrorState
            error={error}
            reset={() => {
              invalidateAll(['identity', 'post-next'])
              reset()
            }}
          />
        )}
      >
        <Suspense fallback={<SkeletonGrid count={6} />}>
          <AdvisorPanel />
        </Suspense>
      </ErrorBoundary>
        </>
      )}
    </div>
  )
}

export function IdentityPage() {
  return (
    <Suspense fallback={<SkeletonGrid count={6} />}>
      <IdentityPageBody />
    </Suspense>
  )
}
