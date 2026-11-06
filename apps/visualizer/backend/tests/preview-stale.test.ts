/**
 * Folder sync preview change detection and vision cache rebuild.
 */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { getVisionCachedImage } from '../src/db/library/vision-cache.js';
import { isDescriptionStale } from '../src/db/library/vision-stale.js';
import { markStaleIfPreviewPhashChanged } from '../src/folder/preview-stale.js';
import { getOrCreateCachedImage } from '../src/vision/vision-cache.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { stringify as stringifyYaml } from 'yaml';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sampleHeic = join(fixtureDir, 'example.heic');

let workDir: string;
let db: Db;
let fx: LibraryFixture;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lt-preview-stale-'));
  fx = new LibraryFixture().activate();
  const cfgPath = join(workDir, 'config.yaml');
  writeFileSync(
    cfgPath,
    stringifyYaml({ vision_cache_dir: join(workDir, 'cache'), mount_point: workDir }),
  );
  process.env.LT_CONFIG_YAML = cfgPath;
  db = openLibraryDb(fx.dbPath);
});

afterEach(() => {
  db.close();
  fx.cleanup();
  delete process.env.LT_CONFIG_YAML;
  rmSync(workDir, { recursive: true, force: true });
});

describe('markStaleIfPreviewPhashChanged', () => {
  it('rebuilds the vision cache when the preview phash changes', async () => {
    const path = join(workDir, 'edit.jpg');
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } })
      .jpeg()
      .toFile(path);
    fx.addImage({ key: '2024-01-01_edit', filepath: path, filename: 'edit' });
    db.prepare(
      "INSERT INTO image_descriptions (image_key, image_type, summary, best_perspective) VALUES (?, 'catalog', 'sum', 'street')",
    ).run('2024-01-01_edit');
    await getOrCreateCachedImage(db, '2024-01-01_edit', path);
    const before = getVisionCachedImage(db, '2024-01-01_edit')!;

    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0000ff' } })
      .jpeg()
      .toFile(path);

    const stale = await markStaleIfPreviewPhashChanged(db, '2024-01-01_edit', path);
    expect(stale).toBe(true);
    expect(isDescriptionStale(db, '2024-01-01_edit')).toBe(true);
    const after = getVisionCachedImage(db, '2024-01-01_edit')!;
    expect(after.phash).not.toBe(before.phash);
    expect(after.compressed_path).toBeTruthy();
  });

  it('uses a viewable path for HEIC when comparing phash', async () => {
    const heicPath = join(workDir, 'photo.heic');
    copyFileSync(sampleHeic, heicPath);
    fx.addImage({ key: '2024-01-01_heic', filepath: heicPath, filename: 'photo' });
    await getOrCreateCachedImage(db, '2024-01-01_heic', heicPath);
    const before = getVisionCachedImage(db, '2024-01-01_heic')!;

    copyFileSync(sampleHeic, heicPath);
    const stale = await markStaleIfPreviewPhashChanged(db, '2024-01-01_heic', heicPath);
    expect(stale).toBe(false);
    expect(getVisionCachedImage(db, '2024-01-01_heic')!.phash).toBe(before.phash);
  });
});
