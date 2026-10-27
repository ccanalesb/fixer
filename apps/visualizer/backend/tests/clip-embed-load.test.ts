/**
 * CLIP model load retries after failure; no real Hub download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fromPretrained = vi.hoisted(() => vi.fn());
const transformersEnv = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('@huggingface/transformers', () => ({
  env: transformersEnv,
  Tensor: class Tensor {
    constructor(
      public dtype: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  },
  CLIPVisionModelWithProjection: {
    from_pretrained: fromPretrained,
  },
}));

describe('CLIP model loading', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('forwards Hub progress to the download callback', async () => {
    fromPretrained.mockImplementation((_id: string, opts: { progress_callback?: (info: unknown) => void }) => {
      opts.progress_callback?.({
        status: 'progress_total',
        loaded: 10_000_000,
        total: 351_685_709,
      });
      return Promise.resolve({});
    });

    const onDownloadProgress = vi.fn();
    const { loadClipModel } = await import('../src/imaging/clip-embed.js');
    await loadClipModel({ onDownloadProgress });

    expect(onDownloadProgress).toHaveBeenCalledWith({
      loaded: 10_000_000,
      total: 351_685_709,
    });
  });

  it('tries the download again after a rejected load', async () => {
    fromPretrained
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(async () => ({ image_embeds: { data: new Float32Array(512).fill(2) } }));

    const { loadClipModel, CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE } = await import(
      '../src/imaging/clip-embed.js'
    );

    await expect(loadClipModel()).rejects.toThrow(CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE);
    await expect(loadClipModel()).resolves.toBeUndefined();
    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });
});
