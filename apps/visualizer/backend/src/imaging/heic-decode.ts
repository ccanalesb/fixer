/**
 * Decode HEIC/HEIF to a temporary JPEG for vision and thumbnails.
 *
 * Bundled sharp reads HEIF metadata but cannot decode HEVC pixels on most builds,
 * so pixels come from WASM libheif everywhere. On macOS, `sips` is tried first.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import decodeHeic from 'heic-decode';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

export const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);

export function isHeicPath(imagePath: string): boolean {
  return HEIC_EXTENSIONS.has(extname(imagePath).toLowerCase());
}

let tempDirPromise: Promise<string> | null = null;
let tempCounter = 0;

async function tempDir(): Promise<string> {
  if (!tempDirPromise) {
    const { mkdtemp } = await import('node:fs/promises');
    tempDirPromise = mkdtemp(join(tmpdir(), 'lt-heic-'));
  }
  return tempDirPromise;
}

async function makeTempJpegPath(): Promise<string> {
  const dir = await tempDir();
  tempCounter += 1;
  return join(dir, `heic-${process.pid}-${tempCounter}.jpg`);
}

async function sipsPresent(): Promise<boolean> {
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
  try {
    const buffer = await readFile(inputPath);
    const { width, height, data } = await decodeHeic({ buffer });
    await sharp(data, { raw: { width, height, channels: 4 } })
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outputPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode the primary HEIC/HEIF image to a JPEG temp file.
 *
 * libheif applies the image's rotation while decoding.
 */
export async function decodeHeicToJpegPath(inputPath: string): Promise<string | null> {
  const outputPath = await makeTempJpegPath();
  if ((await sipsPresent()) && (await decodeWithSips(inputPath, outputPath))) {
    return outputPath;
  }
  if (await decodeWithLibheif(inputPath, outputPath)) return outputPath;
  return null;
}
