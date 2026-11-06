/**
 * Resolve one on-disk folder-catalog photo (including RAW+JPEG pairing) from a filepath.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isJpegExtension, isPhotoFilename, isRawExtension, photoExtension } from './photo-extensions.js';
import type { ResolvedFolderPhoto } from './walk.js';

function photoFilesInDir(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => isPhotoFilename(n)).map((n) => join(dir, n));
}

/** Whether `<stem>.xmp` in this directory is shared by two photos that are not a RAW+JPEG pair. */
export function stemSidecarAmbiguousForDir(dir: string, stem: string): boolean {
  const stemLower = stem.toLowerCase();
  const matches = photoFilesInDir(dir).filter((p) => basename(p, photoExtension(p)).toLowerCase() === stemLower);
  if (matches.length <= 1) return false;
  const raw = matches.find((p) => isRawExtension(photoExtension(p)));
  const jpeg = matches.find((p) => isJpegExtension(photoExtension(p)));
  if (matches.length === 2 && raw && jpeg) return false;
  return true;
}

export function resolveFolderPhotoAtPath(catalogRoot: string, filepath: string): ResolvedFolderPhoto | null {
  const abs = resolve(filepath);
  if (!existsSync(abs)) return null;
  const root = resolve(catalogRoot);
  const relPath = relative(root, abs);
  const dir = dirname(abs);
  const name = basename(abs);
  const ext = photoExtension(name);
  const stem = basename(name, ext);

  if (isRawExtension(ext)) {
    const jpeg = photoFilesInDir(dir).find(
      (p) =>
        isJpegExtension(photoExtension(p)) &&
        basename(p, photoExtension(p)).toLowerCase() === stem.toLowerCase(),
    );
    return {
      filepath: abs,
      relPath,
      filename: stem,
      stem,
      jpegFilepath: jpeg,
    };
  }

  const raw = photoFilesInDir(dir).find(
    (p) =>
      isRawExtension(photoExtension(p)) &&
      basename(p, photoExtension(p)).toLowerCase() === stem.toLowerCase(),
  );
  if (raw) {
    return {
      filepath: raw,
      relPath: relative(root, raw),
      filename: stem,
      stem,
      jpegFilepath: abs,
    };
  }

  return {
    filepath: abs,
    relPath,
    filename: stem,
    stem,
  };
}
