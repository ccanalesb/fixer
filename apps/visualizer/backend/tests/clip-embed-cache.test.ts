/**
 * CLIP cache directory and on-disk detection — no Hub download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const savedDataDir = vi.hoisted(() => ({ value: process.env.LT_DATA_DIR }));

vi.mock('@huggingface/transformers', () => ({
  env: {},
  Tensor: class Tensor {
    constructor(
      public dtype: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
  CLIPVisionModelWithProjection: {
    from_pretrained: vi.fn().mockResolvedValue({}),
  },
}));

describe('CLIP cache', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lt-clip-cache-'));
    process.env.LT_DATA_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDataDir.value === undefined) delete process.env.LT_DATA_DIR;
    else process.env.LT_DATA_DIR = savedDataDir.value;
    vi.resetModules();
  });

  it('stores the transformers.js cache under the data folder', async () => {
    const { clipCacheDir } = await import('../src/config.js');
    const { loadClipModel } = await import('../src/imaging/clip-embed.js');
    const { env } = await import('@huggingface/transformers');

    await loadClipModel();

    expect(clipCacheDir()).toBe(join(dir, 'clip'));
    expect(env.cacheDir).toBe(join(dir, 'clip'));
  });

  it('reports model_on_disk when the fp32 vision weights are present', async () => {
    const { clipModelOnnxPath, isClipModelOnDisk } = await import('../src/imaging/clip-embed.js');
    expect(isClipModelOnDisk()).toBe(false);

    mkdirSync(join(clipModelOnnxPath(), '..'), { recursive: true });
    writeFileSync(clipModelOnnxPath(), 'onnx');

    expect(isClipModelOnDisk()).toBe(true);
  });

  it('formats the Job Queue download step in megabytes', async () => {
    const { formatClipModelDownloadStep } = await import('../src/imaging/clip-embed.js');
    expect(formatClipModelDownloadStep(52_000_000, 351_685_709)).toBe(
      'Downloading the image model (once) — 52 / 352 MB',
    );
  });
});
