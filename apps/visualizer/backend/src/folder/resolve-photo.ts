/**
 * Resolve one on-disk folder-catalog photo (including RAW+JPEG pairing) from a filepath.
 *
 * Reads the photo's own directory and applies the walk's rules to it, so a single
 * photo resolves exactly as a full sync would resolve it.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isResolvedPathInsideDir } from '../utils/path-containment.js';
import { resolveFolderPhotos, walkedPhotoFile, type ResolvedFolderPhoto, type WalkedPhotoFile } from './walk.js';
import { findAmbiguousStemSidecarDirs } from './xmp-sidecars.js';

function photoFilesInDir(rootReal: string, dir: string): WalkedPhotoFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: WalkedPhotoFile[] = [];
  for (const name of names) {
    const file = walkedPhotoFile(rootReal, dir, name);
    if (file) out.push(file);
  }
  return out;
}

/**
 * Whether `<stem>.xmp` sidecars in this directory are ambiguous. Decided per
 * directory, as the sync decides it, so `stem` does not change the answer.
 */
export function stemSidecarAmbiguousForDir(dir: string): boolean {
  const abs = resolve(dir);
  return findAmbiguousStemSidecarDirs(resolveFolderPhotos(photoFilesInDir(abs, abs))).has(abs);
}

/** The photo `filepath` belongs to, or null when it is missing, not a photo, or outside the root. */
export function resolveFolderPhotoAtPath(catalogRoot: string, filepath: string): ResolvedFolderPhoto | null {
  const root = resolve(catalogRoot);
  const abs = resolve(filepath);
  if (abs === root || !isResolvedPathInsideDir(root, abs)) return null;
  if (!existsSync(abs)) return null;
  const photos = resolveFolderPhotos(photoFilesInDir(root, dirname(abs)));
  return photos.find((p) => p.filepath === abs || p.jpegFilepath === abs) ?? null;
}
