/**
 * Catalog change preview and apply.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { applyCatalogChange, previewCatalogChange } from '../src/catalog-change.js';
import {
  CATALOG_PATH_META_KEY,
  generateCatalogFolderName,
  resetCatalogLibraryModuleStateForTests,
} from '../src/catalog-library.js';
import { initLibraryDb, setLibraryMeta } from '../src/db/library/bootstrap.js';
import { libraryWrite } from '../src/db/library/write.js';
import { createJob, initJobsDb } from '../src/db/jobs/jobs.js';

let dir: string;
let cfgPath: string;
let visualizerDb: string;

const readCfg = (): Record<string, unknown> =>
  parseYaml(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;

function seedCatalogLibrary(catalogPath: string): string {
  const folderName = generateCatalogFolderName(catalogPath);
  const catalogFolder = join(dir, 'catalogs', folderName);
  mkdirSync(catalogFolder, { recursive: true });
  const libraryPath = join(catalogFolder, 'library.db');
  const db = initLibraryDb(libraryPath);
  libraryWrite(db, () => setLibraryMeta(db, CATALOG_PATH_META_KEY, catalogPath));
  db.close();
  return libraryPath;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-catchg-'));
  cfgPath = join(dir, 'config.yaml');
  visualizerDb = join(dir, 'visualizer.db');
  process.env.LT_CONFIG_YAML = cfgPath;
  process.env.LT_DATA_DIR = dir;
  process.env.DATABASE_PATH = visualizerDb;
  delete process.env.LIBRARY_DB;
  resetCatalogLibraryModuleStateForTests();
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  delete process.env.LT_DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.LIBRARY_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe('previewCatalogChange', () => {
  it('asks same or different when both are .lrcat and the new one has no library', () => {
    const current = join(dir, 'Final-v13.lrcat');
    const next = join(dir, 'Final-v14.lrcat');
    writeFileSync(current, 'x');
    writeFileSync(next, 'x');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(current)}\n`);
    seedCatalogLibrary(current);

    const preview = previewCatalogChange(next);
    expect('error' in preview).toBe(false);
    if ('error' in preview) return;
    expect(preview.ask_same_or_different).toBe(true);
    expect(preview.jobs_to_cancel).toEqual([]);
  });

  it('skips the same-or-different question when the new catalog already has a library', () => {
    const current = join(dir, 'A.lrcat');
    const next = join(dir, 'B.lrcat');
    writeFileSync(current, 'x');
    writeFileSync(next, 'x');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(current)}\n`);
    seedCatalogLibrary(current);
    seedCatalogLibrary(next);

    const preview = previewCatalogChange(next);
    if ('error' in preview) throw new Error(preview.error);
    expect(preview.ask_same_or_different).toBe(false);
  });
});

describe('applyCatalogChange', () => {
  it('update_path rewrites library_meta and config without cancelling jobs', () => {
    const current = join(dir, 'Old.lrcat');
    const next = join(dir, 'Moved', 'Old.lrcat');
    writeFileSync(current, 'x');
    mkdirSync(join(dir, 'Moved'), { recursive: true });
    writeFileSync(next, 'x');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(current)}\n`);
    const libraryPath = seedCatalogLibrary(current);

    const jobsDb = initJobsDb(visualizerDb);
    const jobId = createJob(jobsDb, 'batch_describe', {});
    jobsDb.close();

    const result = applyCatalogChange(next, 'update_path');
    if ('error' in result) throw new Error(result.error);
    expect(result.cancelled_job_ids).toEqual([]);
    expect(result.catalog_sync_job_id).toBeTruthy();
    expect(readCfg().catalog_path).toBe(next);

    const metaDb = initLibraryDb(libraryPath);
    const recorded = metaDb.prepare('SELECT value FROM library_meta WHERE key = ?').get(
      CATALOG_PATH_META_KEY,
    ) as { value: string };
    metaDb.close();
    expect(recorded.value).toBe(next);

    const jobsDb2 = initJobsDb(visualizerDb);
    expect(jobsDb2.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId)).toEqual({
      status: 'pending',
    });
    jobsDb2.close();
  });

  it('switch cancels catalog jobs and points config at the new path', () => {
    const current = join(dir, 'Current.lrcat');
    const next = join(dir, 'Other.lrcat');
    writeFileSync(current, 'x');
    writeFileSync(next, 'x');
    writeFileSync(cfgPath, `catalog_path: ${JSON.stringify(current)}\n`);
    seedCatalogLibrary(current);

    const jobsDb = initJobsDb(visualizerDb);
    const jobId = createJob(jobsDb, 'catalog_sync', {});
    jobsDb.close();

    const result = applyCatalogChange(next, 'switch');
    if ('error' in result) throw new Error(result.error);
    expect(result.cancelled_job_ids).toContain(jobId);
    expect(readCfg().catalog_path).toBe(next);
  });

  it('does not queue catalog_sync when switching to an empty catalog with no libraries', () => {
    const next = join(dir, 'photos');
    mkdirSync(next, { recursive: true });
    writeFileSync(cfgPath, 'catalog_path: ""\n');

    const result = applyCatalogChange(next, 'switch');
    if ('error' in result) throw new Error(result.error);
    expect(result.catalog_sync_job_id).toBeNull();
  });
});
