/**
 * Jobs run through `tick` bring the catalog cache up to date before their own
 * work, which would sync a real catalog and download the CLIP model. Every test
 * gets a check that finds the cache current; `catalog-cache-check.test.ts`
 * unmocks it to test the real one.
 */
import { vi } from 'vitest';

vi.mock('../../src/jobs/handlers/catalog-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/jobs/handlers/catalog-cache.js')>()),
  ensureCatalogCache: async () => true,
}));
