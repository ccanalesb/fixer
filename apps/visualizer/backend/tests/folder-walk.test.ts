/**
 * Folder catalog walk — extensions, skips, RAW+JPEG pairing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderCatalogStats, walkFolderCatalog } from '../src/folder/walk.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-folder-walk-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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

  it('reports stats through folderCatalogStats', () => {
    writeFileSync(join(dir, 'solo.webp'), 'webp');
    expect(folderCatalogStats(dir)).toEqual({ photoCount: 1, folderCount: 1 });
  });
});
