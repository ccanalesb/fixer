/**
 * CLIP image embeddings.
 *
 * Preprocessing uses `clipPixelValues` rather than transformers.js's `AutoProcessor`:
 * sharp/libvips resize drifts embeddings to ~0.93 cosine against stored vectors.
 * Weights stay fp32; quantized models measured no faster.
 */
import { CLIPVisionModelWithProjection, Tensor, env } from '@huggingface/transformers';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clipCacheDir } from '../config.js';
import { serializeFloat32 } from '../db/connection.js';
import { CLIP_PIXEL_VALUES_SHAPE, clipPixelValues } from './clip-preprocess.js';
import { decodePlaneFromFile } from './decode-plane.js';
import type { Plane } from './pil-resample.js';

/** Must match the model id recorded alongside the stored vectors. */
export const CLIP_EMBED_MODEL_ID = 'clip-ViT-B-32';
/** The transformers.js/ONNX export of the same weights. */
export const CLIP_ONNX_MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const CLIP_EMBED_DIM = 512;

/** fp32 `vision_model.onnx` on the Hub (used for progress totals when the callback omits them). */
export const CLIP_MODEL_WEIGHT_BYTES = 351_685_709;
export const CLIP_MODEL_PROGRESS_TOTAL_MB = 352;

/** Shown when `from_pretrained` cannot reach the Hub. */
export const CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE =
  'Could not download the image model (about 350 MB) from huggingface.co. Check the internet connection and retry.';

export interface ClipModelDownloadProgress {
  loaded: number;
  total: number;
}

export interface LoadClipModelOptions {
  onDownloadProgress?: (progress: ClipModelDownloadProgress) => void;
}

type VisionModel = Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>;

let modelPromise: Promise<VisionModel> | null = null;
let envConfigured = false;

function configureClipEnv(): void {
  if (envConfigured) return;
  env.allowLocalModels = false;
  env.cacheDir = clipCacheDir();
  envConfigured = true;
}

/** Cached fp32 vision weights path under `env.cacheDir`. */
export function clipModelOnnxPath(): string {
  return join(clipCacheDir(), ...`${CLIP_ONNX_MODEL_ID}/onnx/vision_model.onnx`.split('/'));
}

/** Whether the fp32 vision ONNX file is already in the CLIP cache folder. */
export function isClipModelOnDisk(): boolean {
  return existsSync(clipModelOnnxPath());
}

/** Job Queue copy while the Hub file streams in. */
export function formatClipModelDownloadStep(loaded: number, total: number): string {
  const loadedMb = Math.min(Math.round(loaded / 1_000_000), CLIP_MODEL_PROGRESS_TOTAL_MB);
  const totalMb =
    total > 0 ? Math.round(total / 1_000_000) : CLIP_MODEL_PROGRESS_TOTAL_MB;
  const displayTotal = Math.max(totalMb, CLIP_MODEL_PROGRESS_TOTAL_MB);
  return `Downloading the image model (once) — ${loadedMb} / ${displayTotal} MB`;
}

function dispatchDownloadProgress(
  info: { status: string; loaded?: number; total?: number },
  onDownloadProgress: LoadClipModelOptions['onDownloadProgress'],
): void {
  if (!onDownloadProgress) return;
  if (info.status !== 'progress' && info.status !== 'progress_total') return;
  const loaded = info.loaded ?? 0;
  const total = info.total ?? 0;
  if (total <= 0 && loaded <= 0) return;
  onDownloadProgress({ loaded, total: total > 0 ? total : CLIP_MODEL_WEIGHT_BYTES });
}

/** Load the vision tower once per process. */
function getModel(options: LoadClipModelOptions = {}): Promise<VisionModel> {
  if (modelPromise === null) {
    configureClipEnv();
    modelPromise = CLIPVisionModelWithProjection.from_pretrained(CLIP_ONNX_MODEL_ID, {
      dtype: 'fp32',
      progress_callback: (info) => dispatchDownloadProgress(info, options.onDownloadProgress),
    }).catch((err: unknown) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

/** `fetch` rejects with these when the connection fails or drops mid-download. */
const NETWORK_FAILURE_MESSAGES = new Set(['fetch failed', 'terminated']);

/** Whether a load failure is the Hub being unreachable, rather than the model failing to load. */
function isHubUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError && NETWORK_FAILURE_MESSAGES.has(err.message)) return true;
  return err.message.includes('huggingface.co');
}

/** Fail fast before walking images when the model cannot be downloaded or loaded. */
export async function loadClipModel(options: LoadClipModelOptions = {}): Promise<void> {
  try {
    await getModel(options);
  } catch (err) {
    if (isHubUnreachable(err)) throw new Error(CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load the image model: ${reason}`);
  }
}

/** Decode an image file to interleaved RGB. */
export async function decodeRgb(path: string): Promise<Plane> {
  return decodePlaneFromFile(path, { colourspace: 'srgb', removeAlpha: true });
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/** Embed already-decoded pixels. Returns an L2-normalized 512-d vector. */
export async function encodePixels(rgb: Plane): Promise<Float32Array> {
  const model = await getModel();
  const pixelValues = new Tensor('float32', clipPixelValues(rgb), [...CLIP_PIXEL_VALUES_SHAPE]);
  const { image_embeds } = await model({ pixel_values: pixelValues });
  return l2Normalize(new Float32Array(image_embeds.data as Float32Array));
}

/**
 * Embed image files sequentially.
 *
 * The ONNX session is already internally threaded; batching here would only add
 * peak memory. Parallelism belongs at the job level, across worker threads.
 */
export async function encodeImages(paths: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const path of paths) {
    out.push(await encodePixels(await decodeRgb(path)));
  }
  return out;
}

/**
 * The `vec0` blob for one embedding.
 *
 * `vec0` stores whatever bytes it is handed, so a wrong-length vector would only
 * surface later as a KNN that silently returns nothing.
 */
export function clipVecBlob(vector: Float32Array): Buffer {
  if (vector.length !== CLIP_EMBED_DIM) {
    throw new Error(`CLIP embedding must be ${CLIP_EMBED_DIM}-d, got ${vector.length}`);
  }
  return serializeFloat32(vector);
}
