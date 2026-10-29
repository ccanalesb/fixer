import { Suspense } from 'react';
import { Link } from 'react-router-dom';
import { Tabs, Tab } from '../components/ui/Tabs';
import { CatalogTab } from '../components/images/CatalogTab';
import { SkeletonGrid } from '../components/ui/page-states';
import { LibraryEmptyPrompt } from '../components/setup/LibraryEmptyPrompt';
import { ErrorBoundary, ErrorState, invalidateAll } from '../data';
import { usePageTab } from '../hooks/usePageTab';
import { useFirstRunSetup } from '../hooks/useFirstRunSetup';
import { IMAGES_TAB_IDS, usePageUiStore } from '../stores/pageUiStore';
import {
  FIRST_RUN_IMAGES_EMPTY_HINT,
  FIRST_RUN_IMPORT_STILL_RUNNING,
  FIRST_RUN_READING_CATALOG,
  FIRST_RUN_SEE_PROGRESS,
  FIRST_RUN_SETUP_ROUTE,
  TAB_CATALOG,
  TAB_CULL_CATALOG,
} from '../constants/strings';
import { CullCatalogTab } from '../components/cull/CullCatalogTab';

const tabSuspenseFallback = <SkeletonGrid count={12} />;

function ImagesPageBody() {
  const firstRun = useFirstRunSetup();
  const imagesTab = usePageUiStore((s) => s.imagesTab);
  const setImagesTab = usePageUiStore((s) => s.setImagesTab);
  const { activeTab, handleTabChange } = usePageTab({
    pagePath: '/images',
    tabIds: IMAGES_TAB_IDS,
    defaultTab: 'catalog',
    storedTab: imagesTab,
    setStoredTab: setImagesTab,
  });

  const tabs: Tab[] = [
    {
      id: 'catalog',
      label: TAB_CATALOG,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['images.catalog']);
                invalidateAll(['perspectives']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <CatalogTab />
          </Suspense>
        </ErrorBoundary>
      ),
    },
    {
      id: 'cull-catalog',
      label: TAB_CULL_CATALOG,
      content: (
        <ErrorBoundary
          fallback={({ error, reset }) => (
            <ErrorState
              error={error}
              reset={() => {
                invalidateAll(['images.catalog']);
                reset();
              }}
            />
          )}
        >
          <Suspense fallback={tabSuspenseFallback}>
            <CullCatalogTab />
          </Suspense>
        </ErrorBoundary>
      ),
    },
  ];

  const subtitle =
    firstRun.catalogPhotoCount > 0
      ? `${firstRun.catalogPhotoCount.toLocaleString('en-US')} photos`
      : 'Browse your catalog.';

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-section text-text mb-2">Images</h1>
        <p className="text-text-secondary">{subtitle}</p>
      </div>

      {firstRun.showImagesReadingCatalog ? (
        <p className="py-12 text-center text-text-secondary">{FIRST_RUN_READING_CATALOG}</p>
      ) : firstRun.showImagesEmpty ? (
        <LibraryEmptyPrompt hint={FIRST_RUN_IMAGES_EMPTY_HINT} />
      ) : (
        <>
          {firstRun.showImagesImportBanner ? (
            <p className="mb-4 text-xs text-text-tertiary">
              {FIRST_RUN_IMPORT_STILL_RUNNING}{' '}
              <Link to={FIRST_RUN_SETUP_ROUTE} className="font-medium text-accent hover:underline">
                {FIRST_RUN_SEE_PROGRESS}
              </Link>
            </p>
          ) : null}
          <Tabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
        </>
      )}
    </div>
  );
}

export function ImagesPage() {
  return (
    <Suspense fallback={tabSuspenseFallback}>
      <ImagesPageBody />
    </Suspense>
  );
}
