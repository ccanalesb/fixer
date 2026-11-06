/**
 * Folder catalog walk — extensions, skips, RAW+JPEG pairing.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  folderCatalogWalkDiagnostics,
  walkFolderCatalog,
} from '../src/folder/walk.js';
import {
  shouldSkipEntryName,
  skipDirectory,
} from '../src/folder/skip-paths.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-walk-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('shouldSkipEntryName', () => {
  it.each([
    ['.hidden', true],
    ['@eaDir', true],
    ['#recycle', true],
    ['$RECYCLE.BIN', true],
    ['System Volume Information', true],
    ['Album.lrdata', true],
    ['Photos.photoslibrary', true],
    ['visible.jpg', false],
  ] as const)('skips %s → %s', (name, skipped) => {
    expect(shouldSkipEntryName(name)).toBe(skipped);
  });
});

describe('walkFolderCatalog', () => {
  it('counts photos and folders in sorted order and skips dot entries', () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'a.jpg'), 'jpeg');
    writeFileSync(join(dir, 'nested', 'b.png'), 'png');
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, '.hidden', 'skip.jpg'), 'nope');

    const { photos, stats } = walkFolderCatalog(dir);
    expect(stats.photoCount).toBe(2);
    expect(stats.folderCount).toBe(2);
    expect(photos.map((p) => p.relPath)).toEqual(['a.jpg', join('nested', 'b.png')]);
  });

  it('treats a RAW and JPEG with the same stem as one photo using the RAW path', () => {
    mkdirSync(join(dir, 'pair'));
    writeFileSync(join(dir, 'pair', 'img.cr2'), 'raw');
    writeFileSync(join(dir, 'pair', 'img.jpg'), 'jpeg');

    const { photos } = walkFolderCatalog(dir);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.filepath).toContain('img.cr2');
    expect(photos[0]!.relPath).toBe(join('pair', 'img.cr2'));
  });

  it('skips fixed system and package directory names', () => {
    for (const name of [
      '@eaDir',
      '#recycle',
      '$RECYCLE.BIN',
      'System Volume Information',
      'cache.lrdata',
      'lib.photoslibrary',
    ]) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'x.jpg'), 'j');
    }
    expect(walkFolderCatalog(dir).stats.photoCount).toBe(0);
  });

  it('skips the data folder and vision cache when they sit under the catalog root', () => {
    const dataDir = join(dir, 'fixer-data');
    const cacheDir = join(dataDir, 'catalogs', 'x', 'vision-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(dataDir, 'secret.jpg'), 'no');
    writeFileSync(join(cacheDir, 'cached.jpg'), 'no');

    vi.stubEnv('LT_DATA_DIR', dataDir);
    const { photos } = walkFolderCatalog(dir);
    vi.unstubAllEnvs();
    expect(photos).toHaveLength(0);
  });

  it('does not follow symlinks and finishes when a directory symlink loops', () => {
    const loop = join(dir, 'loop');
    mkdirSync(loop);
    symlinkSync(loop, join(loop, 'child'));
    writeFileSync(join(dir, 'real.jpg'), 'ok');
    expect(walkFolderCatalog(dir).photos).toHaveLength(1);
  });

  it('records directories that cannot be read', () => {
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'a.jpg'), 'j');
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      const { unreadableDirectories } = folderCatalogWalkDiagnostics(dir);
      expect(unreadableDirectories.some((p) => p.includes('locked'))).toBe(true);
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
    }
  });

  it('reports stats through folderCatalogWalkDiagnostics', () => {
    writeFileSync(join(dir, 'solo.webp'), 'webp');
    expect(folderCatalogWalkDiagnostics(dir).stats).toEqual({ photoCount: 1, folderCount: 1 });
  });

  it('does not enter a skipped directory basename', () => {
    expect(skipDirectory(join(dir, '@eaDir'), [])).toBe(true);
  });
});
