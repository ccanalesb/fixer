import { Suspense } from 'react';
import { Tabs, Tab } from '../components/ui/Tabs';
import { CatalogTab } from '../components/images/CatalogTab';
import { SkeletonGrid } from '../components/ui/page-states';
import { ErrorBoundary, ErrorState, invalidateAll } from '../data';
import { usePageTab } from '../hooks/usePageTab';
import { IMAGES_TAB_IDS, usePageUiStore } from '../stores/pageUiStore';
import { TAB_CATALOG, TAB_CULL_CATALOG } from '../constants/strings';
import { CullCatalogTab } from '../components/cull/CullCatalogTab';

const tabSuspenseFallback = <SkeletonGrid count={12} />;

export function ImagesPage() {
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

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-section text-text mb-2">Images</h1>
        <p className="text-text-secondary">
          Browse catalog images and search AI descriptions
        </p>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} />
    </div>
  );
}
