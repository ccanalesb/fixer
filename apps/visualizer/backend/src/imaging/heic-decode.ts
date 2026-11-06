/**
 * Decode HEIC/HEIF to a temporary JPEG for vision and thumbnails.
 *
 * Bundled sharp reads HEIF metadata but cannot decode HEVC pixels on most builds,
 * so pixels come from WASM libheif everywhere. On macOS, `sips` is tried first.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import decodeHeic from 'heic-decode';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

/** Longest edge for decoded HEIC JPEGs — matches vision cache compression input. */
const PREVIEW_MAX_DIMENSION = Number(process.env.VISION_MAX_DIMENSION ?? '1024');

/** Cap simultaneous libheif decodes so large files do not exhaust memory. */
const MAX_CONCURRENT_LIBHEIF_DECODES = 2;

let sipsPresenceOverride: (() => Promise<boolean>) | null = null;

let libheifInFlight = 0;
const libheifWaiters: Array<() => void> = [];

async function acquireLibheifSlot(): Promise<void> {
  if (libheifInFlight < MAX_CONCURRENT_LIBHEIF_DECODES) {
    libheifInFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    libheifWaiters.push(() => {
      libheifInFlight += 1;
      resolve();
    });
  });
}

function releaseLibheifSlot(): void {
  libheifInFlight -= 1;
  const next = libheifWaiters.shift();
  if (next) next();
}

/** Test seam: pretend `sips` is available without running it. */
export function setHeicDecodeSipsPresenceOverride(fn: (() => Promise<boolean>) | null): void {
  sipsPresenceOverride = fn;
}

export const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

export function isHeicPath(imagePath: string): boolean {
  return HEIC_EXTENSIONS.has(extname(imagePath).toLowerCase());
}

async function sipsPresent(): Promise<boolean> {
  if (sipsPresenceOverride) return sipsPresenceOverride();
  if (process.platform !== 'darwin') return false;
  try {
    await execFileAsync('which', ['sips']);
    return true;
  } catch {
    return false;
  }
}

async function decodeWithSips(inputPath: string, outputPath: string): Promise<boolean> {
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', inputPath, '--out', outputPath]);
    return true;
  } catch {
    return false;
  }
}

async function decodeWithLibheif(inputPath: string, outputPath: string): Promise<boolean> {
  await acquireLibheifSlot();
  try {
    const buffer = await readFile(inputPath);
    const { width, height, data } = await decodeHeic({ buffer });
    const pipeline = sharp(data, { raw: { width, height, channels: 4 } });
    if (width > PREVIEW_MAX_DIMENSION || height > PREVIEW_MAX_DIMENSION) {
      pipeline.resize({
        width: PREVIEW_MAX_DIMENSION,
        height: PREVIEW_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3',
      });
    }
    await pipeline.jpeg({ quality: 92, mozjpeg: true }).toFile(outputPath);
    return true;
  } catch {
    return false;
  } finally {
    releaseLibheifSlot();
  }
}

/**
 * Decode the primary HEIC/HEIF image to a JPEG temp file. Returns `null` when
 * it cannot.
 *
 * libheif applies the image's rotation while decoding, so the JPEG is upright.
 */
export async function decodeHeicToJpegPath(
  inputPath: string,
  tempPathFactory: () => Promise<string>,
): Promise<string | null> {
  const outputPath = await tempPathFactory();
  if ((await sipsPresent()) && (await decodeWithSips(inputPath, outputPath))) {
    return outputPath;
  }
  if (await decodeWithLibheif(inputPath, outputPath)) return outputPath;
  return null;
}
