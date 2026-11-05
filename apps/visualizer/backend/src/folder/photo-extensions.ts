import { extname } from 'node:path';
import { RAW_EXTENSIONS, VIDEO_EXTENSIONS } from '../imaging/raw-decode.js';

const RASTER_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
  '.avif',
]);

export function photoExtension(filename: string): string {
  return extname(filename).toLowerCase();
}

export function isPhotoFilename(filename: string): boolean {
  const ext = photoExtension(filename);
  if (!ext || VIDEO_EXTENSIONS.has(ext)) return false;
  return RAW_EXTENSIONS.has(ext) || RASTER_EXTENSIONS.has(ext);
}

export function isRawExtension(ext: string): boolean {
  return RAW_EXTENSIONS.has(ext.toLowerCase());
}

export function isJpegExtension(ext: string): boolean {
  const e = ext.toLowerCase();
  return e === '.jpg' || e === '.jpeg';
}
