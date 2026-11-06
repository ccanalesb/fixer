/**
 * HEIC/HEIF decode for folder catalog previews.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { decodeHeicToJpegPath, setHeicDecodeSipsPresenceOverride } from '../src/imaging/heic-decode.js';
import { getViewablePathManaged, makeTempJpgPath } from '../src/imaging/image-prep.js';
import { getOrCreateCachedImage } from '../src/vision/vision-cache.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { stringify as stringifyYaml } from 'yaml';
import { writeFileSync } from 'node:fs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sampleHeic = join(fixtureDir, 'example.heic');

let workDir: string;
let db: Db;
let fx: LibraryFixture;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'lt-heic-'));
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
  setHeicDecodeSipsPresenceOverride(null);
  vi.restoreAllMocks();
});

describe('decodeHeicToJpegPath', () => {
  it('decodes a HEVC HEIC to a JPEG with libheif', async () => {
    const heicPath = join(workDir, 'photo.heic');
    copyFileSync(sampleHeic, heicPath);
    setHeicDecodeSipsPresenceOverride(async () => false);

    const jpegPath = (await decodeHeicToJpegPath(heicPath, makeTempJpgPath))!;
    expect(jpegPath).toBeTruthy();
    const meta = await sharp(jpegPath).metadata();
    expect(meta.width).toBeLessThanOrEqual(1024);
    expect(meta.height).toBeLessThanOrEqual(854);
    expect(meta.format).toBe('jpeg');
  });

  it('uses sips on macOS when available', async () => {
    if (process.platform !== 'darwin') return;
    const heicPath = join(workDir, 'sips.heic');
    copyFileSync(sampleHeic, heicPath);
    const jpegPath = (await decodeHeicToJpegPath(heicPath, makeTempJpgPath))!;
    expect(jpegPath).toBeTruthy();
    const meta = await sharp(jpegPath).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
  });

  it('falls back to libheif when sips fails', async () => {
    const heicPath = join(workDir, 'fallback.heic');
    copyFileSync(sampleHeic, heicPath);
    setHeicDecodeSipsPresenceOverride(async () => true);
    try {
      const jpegPath = (await decodeHeicToJpegPath(heicPath, makeTempJpgPath))!;
      expect(jpegPath).toBeTruthy();
      expect(await sharp(jpegPath).metadata()).toMatchObject({ format: 'jpeg' });
    } finally {
      setHeicDecodeSipsPresenceOverride(null);
    }
  });

  it('logs why each decoder failed when none can decode the file', async () => {
    const brokenPath = join(workDir, 'broken.heic');
    writeFileSync(brokenPath, 'not a heic');
    setHeicDecodeSipsPresenceOverride(async () => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await decodeHeicToJpegPath(brokenPath, makeTempJpgPath)).toBeNull();
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toMatch(/sips could not decode .*broken\.heic: \S/);
    expect(logged).toMatch(/libheif could not decode .*broken\.heic: \S/);
  });
});

describe('HEIC vision cache', () => {
  it('builds a vision cache JPEG larger than one megapixel from a folder HEIC', async () => {
    const heicPath = join(workDir, 'IMG_0001.HEIC');
    copyFileSync(sampleHeic, heicPath);
    fx.addImage({ key: '2024-01-01_heic', filepath: heicPath, filename: 'IMG_0001' });

    const cached = await getOrCreateCachedImage(db, '2024-01-01_heic', heicPath);
    expect(cached).toBeTruthy();
    const meta = await sharp(cached!).metadata();
    expect(meta.format).toBe('jpeg');
    expect((meta.width ?? 0) * (meta.height ?? 0)).toBeGreaterThan(500_000);
  });

  it('resolves a viewable JPEG path for HEIC', async () => {
    const heicPath = join(workDir, 'view.heic');
    copyFileSync(sampleHeic, heicPath);
    const viewable = await getViewablePathManaged(heicPath);
    expect(viewable.isTemp).toBe(true);
    expect(await sharp(viewable.path).metadata()).toMatchObject({ format: 'jpeg' });
  });
});
