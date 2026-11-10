/**
 * Folder catalog exiftool startup errors.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { folderExifStartupErrorMessage } from '../src/folder/exif-read.js';

const { mockVersion } = vi.hoisted(() => ({
  mockVersion: vi.fn(),
}));

vi.mock('exiftool-vendored', () => ({
  ExifTool: class MockExifTool {
    constructor() {}
    version = mockVersion;
    read = vi.fn().mockResolvedValue({});
    end = vi.fn().mockResolvedValue(undefined);
  },
}));

import { createFolderExifSession } from '../src/folder/exif-read.js';
import { syncFolderCatalog } from '../src/folder/sync.js';

describe('folderExifStartupErrorMessage', () => {
  it('names the perl package on Linux when Perl is missing', () => {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const msg = folderExifStartupErrorMessage(new Error('spawn perl ENOENT'));
      expect(msg).toMatch(/install the perl package/);
      expect(msg).toMatch(/exiftool failed to start/);
    } finally {
      Object.defineProperty(process, 'platform', { value: prev });
    }
  });

  it('passes through other startup errors', () => {
    const msg = folderExifStartupErrorMessage(new Error('batch cluster timeout'));
    expect(msg).toBe('exiftool failed to start: batch cluster timeout');
  });
});

describe('createFolderExifSession.ensureReady', () => {
  it('reports a startup failure once', async () => {
    mockVersion.mockRejectedValueOnce(new Error('spawn perl ENOENT'));
    const session = createFolderExifSession();
    const first = await session.ensureReady();
    const second = await session.ensureReady();
    expect(first).toMatch(/exiftool failed to start/);
    expect(second).toBe(first);
    expect(mockVersion).toHaveBeenCalledTimes(1);
    await session.end();
  });

  it('returns null when exiftool starts', async () => {
    mockVersion.mockResolvedValueOnce('13.60');
    const session = createFolderExifSession();
    expect(await session.ensureReady()).toBeNull();
    await session.end();
  });
});

describe('syncFolderCatalog exiftool startup', () => {
  let dir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-folder-exif-start-'));
    root = join(dir, 'photos');
    mkdirSync(root, { recursive: true });
    dbPath = join(dir, 'library.db');
    mockVersion.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs one error when exiftool cannot start', async () => {
    mockVersion.mockRejectedValue(new Error('spawn perl ENOENT'));
    writeFileSync(join(root, 'one.jpg'), 'fake-jpeg');
    const logs: string[] = [];
    const db = initLibraryDb(dbPath);
    try {
      await syncFolderCatalog(root, db, {
        log: (level, message) => logs.push(`${level}:${message}`),
      });
      const exifErrors = logs.filter((l) => l.includes('exiftool failed to start'));
      expect(exifErrors).toHaveLength(1);
      expect(exifErrors[0]).toMatch(/^error:/);
    } finally {
      db.close();
    }
  });
});
