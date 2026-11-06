/**
 * Folder catalog walk — extensions, skips, RAW+JPEG pairing.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  folderCatalogWalkDiagnostics,
  walkFolderCatalog,
} from '../src/folder/walk.js';
import {
  isUnderSkippedRoot,
  shouldSkipEntryName,
  skipRootsInside,
} from '../src/folder/skip-paths.js';
import { resolveFolderPhotoAtPath, stemSidecarAmbiguousForDir } from '../src/folder/resolve-photo.js';

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
  it('counts HEIC and HEIF extensions in any case', async () => {
    writeFileSync(join(dir, 'iphone.HEIC'), 'heic');
    writeFileSync(join(dir, 'other.HeIf'), 'heif');
    const { stats, photos } = (await walkFolderCatalog(dir))!;
    expect(stats.photoCount).toBe(2);
    expect(photos.map((p) => p.relPath).sort()).toEqual(['iphone.HEIC', 'other.HeIf']);
  });

  it('counts photos and folders in sorted order and skips dot entries', async () => {
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'a.jpg'), 'jpeg');
    writeFileSync(join(dir, 'nested', 'b.png'), 'png');
    mkdirSync(join(dir, '.hidden'), { recursive: true });
    writeFileSync(join(dir, '.hidden', 'skip.jpg'), 'nope');

    const { photos, stats } = (await walkFolderCatalog(dir))!;
    expect(stats.photoCount).toBe(2);
    expect(stats.folderCount).toBe(2);
    expect(photos.map((p) => p.relPath)).toEqual(['a.jpg', join('nested', 'b.png')]);
  });

  it('treats a RAW and JPEG with the same stem as one photo using the RAW path', async () => {
    mkdirSync(join(dir, 'pair'));
    writeFileSync(join(dir, 'pair', 'img.cr2'), 'raw');
    writeFileSync(join(dir, 'pair', 'img.jpg'), 'jpeg');

    const { photos } = (await walkFolderCatalog(dir))!;
    expect(photos).toHaveLength(1);
    expect(photos[0]!.filepath).toContain('img.cr2');
    expect(photos[0]!.relPath).toBe(join('pair', 'img.cr2'));
  });

  it('pairs a RAW and JPEG whose extensions are upper case', async () => {
    writeFileSync(join(dir, 'IMG_1.CR2'), 'raw');
    writeFileSync(join(dir, 'IMG_1.JPG'), 'jpeg');
    const { photos } = (await walkFolderCatalog(dir))!;
    expect(photos).toEqual([
      {
        filepath: join(dir, 'IMG_1.CR2'),
        relPath: 'IMG_1.CR2',
        filename: 'IMG_1',
        stem: 'IMG_1',
        jpegFilepath: join(dir, 'IMG_1.JPG'),
      },
    ]);
  });

  it('skips fixed system and package directory names', async () => {
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
    expect((await walkFolderCatalog(dir))!.stats.photoCount).toBe(0);
  });

  it('skips the data folder and vision cache when they sit under the catalog root', async () => {
    const dataDir = join(dir, 'fixer-data');
    const cacheDir = join(dataDir, 'catalogs', 'x', 'vision-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(dataDir, 'secret.jpg'), 'no');
    writeFileSync(join(cacheDir, 'cached.jpg'), 'no');

    vi.stubEnv('LT_DATA_DIR', dataDir);
    const { photos } = (await walkFolderCatalog(dir))!;
    vi.unstubAllEnvs();
    expect(photos).toHaveLength(0);
  });

  it('does not follow symlinks and finishes when a directory symlink loops', async () => {
    const loop = join(dir, 'loop');
    mkdirSync(loop);
    symlinkSync(loop, join(loop, 'child'));
    writeFileSync(join(dir, 'real.jpg'), 'ok');
    expect((await walkFolderCatalog(dir))!.photos).toHaveLength(1);
  });

  it('records directories that cannot be read', async () => {
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'a.jpg'), 'j');
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      const { unreadableDirectories } = (await folderCatalogWalkDiagnostics(dir));
      expect(unreadableDirectories.some((p) => p.includes('locked'))).toBe(true);
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
    }
  });

  it('reports stats through folderCatalogWalkDiagnostics', async () => {
    writeFileSync(join(dir, 'solo.webp'), 'webp');
    expect((await folderCatalogWalkDiagnostics(dir)).stats).toEqual({ photoCount: 1, folderCount: 1 });
  });

  it.each(['Library.photoslibrary', '.photos', '@eaDir'])(
    'walks a chosen root named %s; the name rules apply only below it',
    async (name) => {
      const root = join(dir, name);
      mkdirSync(join(root, 'sub'), { recursive: true });
      writeFileSync(join(root, 'sub', 'a.jpg'), 'j');
      mkdirSync(join(root, 'sub', '.hidden'));
      writeFileSync(join(root, 'sub', '.hidden', 'b.jpg'), 'j');
      expect((await walkFolderCatalog(root))!.photos.map((p) => p.relPath)).toEqual([
        join('sub', 'a.jpg'),
      ]);
    },
  );

  it('stops before reading the next folder when asked to', async () => {
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'a', '1.jpg'), 'j');
    writeFileSync(join(dir, 'b', '2.jpg'), 'j');
    let checks = 0;
    const result = await walkFolderCatalog(dir, {
      shouldStop: () => {
        checks += 1;
        return checks > 1;
      },
    });
    expect(result).toBeNull();
    expect(checks).toBe(2);
  });
});

describe('skip roots under the catalog root', () => {
  it('finds the data folder under a Windows catalog root', () => {
    expect(
      skipRootsInside('C:\\Photos', ['C:\\Photos\\fixer-data', 'D:\\elsewhere', 'C:\\Photos2'], win32),
    ).toEqual(['C:\\Photos\\fixer-data']);
  });

  it('matches paths below a skip root by path segments, not string prefix', () => {
    expect(isUnderSkippedRoot('C:\\Photos\\data\\x.jpg', ['C:\\Photos\\data'], win32)).toBe(true);
    expect(isUnderSkippedRoot('C:\\Photos\\data2\\x.jpg', ['C:\\Photos\\data'], win32)).toBe(false);
    expect(isUnderSkippedRoot(join(dir, 'data2', 'x.jpg'), [join(dir, 'data')])).toBe(false);
  });
});

describe('resolveFolderPhotoAtPath', () => {
  it('resolves the JPEG of a pair to the RAW photo', () => {
    writeFileSync(join(dir, 'img.CR2'), 'raw');
    writeFileSync(join(dir, 'img.jpg'), 'jpeg');
    const photo = resolveFolderPhotoAtPath(dir, join(dir, 'img.jpg'));
    expect(photo).toMatchObject({
      filepath: join(dir, 'img.CR2'),
      relPath: 'img.CR2',
      jpegFilepath: join(dir, 'img.jpg'),
    });
  });

  it('returns null for a file outside the catalog root', () => {
    const root = join(dir, 'root');
    mkdirSync(root);
    writeFileSync(join(dir, 'outside.jpg'), 'j');
    expect(resolveFolderPhotoAtPath(root, join(root, '..', 'outside.jpg'))).toBeNull();
    expect(resolveFolderPhotoAtPath(root, join(dir, 'outside.jpg'))).toBeNull();
  });

  it('returns null for a file that is not a photo', () => {
    writeFileSync(join(dir, 'notes.txt'), 't');
    expect(resolveFolderPhotoAtPath(dir, join(dir, 'notes.txt'))).toBeNull();
  });
});

describe('stemSidecarAmbiguousForDir', () => {
  it('agrees with the sync: a RAW+JPEG pair is not ambiguous, two rasters with one stem are', () => {
    writeFileSync(join(dir, 'pair.nef'), 'raw');
    writeFileSync(join(dir, 'pair.jpg'), 'jpeg');
    expect(stemSidecarAmbiguousForDir(dir)).toBe(false);
    writeFileSync(join(dir, 'twin.png'), 'png');
    writeFileSync(join(dir, 'twin.tif'), 'tif');
    expect(stemSidecarAmbiguousForDir(dir)).toBe(true);
  });
});
