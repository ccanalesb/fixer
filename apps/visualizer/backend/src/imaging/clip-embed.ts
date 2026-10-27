/**
 * CLIP image embeddings.
 *
 * Preprocessing uses `clipPixelValues` rather than transformers.js's `AutoProcessor`:
 * sharp/libvips resize drifts embeddings to ~0.93 cosine against stored vectors.
 * Weights stay fp32; quantized models measured no faster.
 */
import { CLIPVisionModelWithProjection, Tensor, env } from '@huggingface/transformers';
import { serializeFloat32 } from '../db/connection.js';
import { CLIP_PIXEL_VALUES_SHAPE, clipPixelValues } from './clip-preprocess.js';
import { decodePlaneFromFile } from './decode-plane.js';
import type { Plane } from './pil-resample.js';

/** Must match the model id recorded alongside the stored vectors. */
export const CLIP_EMBED_MODEL_ID = 'clip-ViT-B-32';
/** The transformers.js/ONNX export of the same weights. */
export const CLIP_ONNX_MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const CLIP_EMBED_DIM = 512;

/** Shown when `from_pretrained` cannot reach the Hub. */
export const CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE =
  'Could not download the CLIP model from huggingface.co.';

type VisionModel = Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>;

let modelPromise: Promise<VisionModel> | null = null;

/** Load the vision tower once per process. */
function getModel(): Promise<VisionModel> {
  if (modelPromise === null) {
    env.allowLocalModels = false;
    modelPromise = CLIPVisionModelWithProjection.from_pretrained(CLIP_ONNX_MODEL_ID, {
      dtype: 'fp32',
    }).catch((err: unknown) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

/** Fail fast before walking images when the Hub is unreachable. */
export async function loadClipModel(): Promise<void> {
  try {
    await getModel();
  } catch {
    throw new Error(CLIP_MODEL_DOWNLOAD_FAILED_MESSAGE);
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
