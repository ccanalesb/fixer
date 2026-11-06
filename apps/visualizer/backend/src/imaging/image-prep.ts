/**
 * Image preparation — viewable paths and vision compression.
 *
 * `compressImage` uses sharp rather than `pil-resample.ts`. CLIP and phash paths
 * need fixture-exact pixels; this path feeds a JPEG to a language model, so sharp's
 * faster resize is sufficient.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { applyOrientation, UPRIGHT, type OrientationCode } from './orientation.js';
import { convertRawToJpg, isRawPath } from './raw-decode.js';
import { decodeHeicToJpegPath, isHeicPath } from './heic-decode.js';

export { RAW_EXTENSIONS, VIDEO_EXTENSIONS, isRawPath, isVideoPath } from './raw-decode.js';
export { isHeicPath } from './heic-decode.js';

/** Longest edge of the image handed to a vision model. */
export const VISION_MAX_DIMENSION = Number(process.env.VISION_MAX_DIMENSION ?? '1024');
export const VISION_COMPRESS_QUALITY = Number(process.env.VISION_COMPRESS_QUALITY ?? '80');

let tempDirPromise: Promise<string> | null = null;

/** One temp directory per process, created lazily. */
async function tempDir(): Promise<string> {
  tempDirPromise ??= mkdtemp(join(tmpdir(), 'lt-vision-'));
  return tempDirPromise;
}

let tempCounter = 0;

/** A unique temp path. The caller owns cleanup. */
export async function makeTempJpgPath(): Promise<string> {
  const dir = await tempDir();
  tempCounter += 1;
  return join(dir, `prep-${process.pid}-${tempCounter}.jpg`);
}

/**
 * Compress an image for a vision call. Returns the new path, or the input path
 * unchanged on failure.
 *
 * Returning the input rather than throwing keeps a batch running past one odd
 * file, but it also means a `.mov` sails through to the provider, which is why
 * `description-service.ts` short-circuits video *before* getting here.
 */
export async function compressImage(
  inputPath: string,
  opts: {
    maxSize?: number;
    quality?: number;
    silent?: boolean;
    /** Applied to the pixels as stored; sharp ignores the file's EXIF orientation. */
    orientation?: OrientationCode;
  } = {},
): Promise<string> {
  const maxSize = opts.maxSize ?? VISION_MAX_DIMENSION;
  const quality = opts.quality ?? VISION_COMPRESS_QUALITY;

  try {
    const image = sharp(inputPath, { failOn: 'none' });
    const meta = await image.metadata();

    const pipeline = applyOrientation(
      image
        // 16-bit and floating-point samples cannot be written as JPEG.
        .removeAlpha()
        .toColourspace('srgb'),
      opts.orientation ?? UPRIGHT,
    );

    // Only shrink. `withoutEnlargement` is a no-op when the image already fits.
    if ((meta.width ?? 0) > maxSize || (meta.height ?? 0) > maxSize) {
      pipeline.resize({
        width: maxSize,
        height: maxSize,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      });
    }

    const outPath = await makeTempJpgPath();
    await pipeline.jpeg({ quality, mozjpeg: true }).toFile(outPath);

    if (!opts.silent) {
      const kb = (p: string): string => (statSync(p).size / 1024).toFixed(1);
      process.stderr.write(` Compressed: ${kb(inputPath)}KB -> ${kb(outPath)}KB\n`);
    }
    return outPath;
  } catch (e) {
    if (!opts.silent) {
      process.stderr.write(
        ` Compression failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    return inputPath;
  }
}

/**
 * A viewable path plus whether it is ours to delete.
 *
 * `isTemp: false` means the original or a persistent on-disk sidecar, which the
 * caller must NOT unlink — deleting a user's `.JPG` next to their RAW would be
 * data loss. `isTemp: true` is a file we created.
 */
export interface ViewablePath {
  path: string;
  isTemp: boolean;
  /** What has already been done to the stored pixels: LibRaw's camera turn, else nothing. */
  orientation: OrientationCode;
}

/**
 * Resolve a viewable image, converting RAW to a temporary JPEG when needed.
 *
 * A sidecar JPEG next to the RAW is preferred over decoding: it is already the
 * photographer's rendering, it costs nothing, and RAW decode is ~872 ms. Both
 * case variants are checked because Lightroom writes `.JPG` while cameras and
 * other tools write `.jpg`.
 */
export async function getViewablePathManaged(imagePath: string): Promise<ViewablePath> {
  if (isHeicPath(imagePath)) {
    const decoded = await decodeHeicToJpegPath(imagePath, makeTempJpgPath);
    if (decoded) return { path: decoded, isTemp: true, orientation: UPRIGHT };
    return { path: imagePath, isTemp: false, orientation: UPRIGHT };
  }

  if (!isRawPath(imagePath)) return { path: imagePath, isTemp: false, orientation: UPRIGHT };

  const stem = imagePath.slice(0, imagePath.lastIndexOf('.'));
  for (const sidecar of [`${stem}.JPG`, `${stem}.jpg`]) {
    if (existsSync(sidecar)) return { path: sidecar, isTemp: false, orientation: UPRIGHT };
  }

  const converted = await convertRawToJpg(imagePath, makeTempJpgPath);
  if (converted) return { path: converted.path, isTemp: true, orientation: converted.orientation };

  // Decode failed: hand back the RAW. `compressImage` will fail on it and
  // return it unchanged, and the provider will reject it — a clear failure
  // rather than a silent skip.
  return { path: imagePath, isTemp: false, orientation: UPRIGHT };
}

/** The viewable path only, for callers that do not manage temp files. */
export async function getViewablePath(imagePath: string): Promise<string> {
  return (await getViewablePathManaged(imagePath)).path;
}

/** Write bytes to a fresh temp JPEG path. Used by tests and the cache builder. */
export async function writeTempJpg(data: Buffer): Promise<string> {
  const path = await makeTempJpgPath();
  await writeFile(path, data);
  return path;
}
