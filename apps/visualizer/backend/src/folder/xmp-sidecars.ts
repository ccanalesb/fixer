/**
 * XMP sidecar paths beside folder-catalog photos.
 */
import { dirname, join } from 'node:path';
import type { FileStatSnapshot } from './lstat-parallel.js';
import type { ResolvedFolderPhoto } from './walk.js';

/** Sidecar paths whose `<stem>.xmp` is shared by two photos that are not a RAW+JPEG pair. */
export function findAmbiguousStemSidecarDirs(photos: readonly ResolvedFolderPhoto[]): Set<string> {
  const byDirStem = new Map<string, number>();
  for (const photo of photos) {
    const dir = dirname(photo.filepath);
    const key = `${dir}\0${photo.stem.toLowerCase()}`;
    byDirStem.set(key, (byDirStem.get(key) ?? 0) + 1);
  }
  const ambiguous = new Set<string>();
  for (const photo of photos) {
    const dir = dirname(photo.filepath);
    const key = `${dir}\0${photo.stem.toLowerCase()}`;
    if ((byDirStem.get(key) ?? 0) > 1) ambiguous.add(dir);
  }
  return ambiguous;
}

/** `<file>.xmp` and, unless the dir's `<stem>.xmp` is shared, `<stem>.xmp` beside it. */
export function sidecarPathsForFile(
  filepath: string,
  stem: string,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): string[] {
  const dir = dirname(filepath);
  const paths = [`${filepath}.xmp`];
  if (!ambiguousStemSidecarDirs.has(dir)) {
    paths.push(join(dir, `${stem}.xmp`));
  }
  return [...new Set(paths)];
}

export function sidecarPathsForPhoto(
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): string[] {
  const paths = sidecarPathsForFile(photo.filepath, photo.stem, ambiguousStemSidecarDirs);
  if (photo.jpegFilepath) {
    paths.push(...sidecarPathsForFile(photo.jpegFilepath, photo.stem, ambiguousStemSidecarDirs));
  }
  return [...new Set(paths)];
}

export function sidecarSignature(
  paths: readonly string[],
  statsByPath: ReadonlyMap<string, FileStatSnapshot>,
): string {
  const parts = [...paths].sort((a, b) => a.localeCompare(b));
  return parts
    .map((p) => {
      const st = statsByPath.get(p);
      if (!st?.readable) return `${p}:missing`;
      return `${p}:${st.size}:${st.mtimeMs}`;
    })
    .join('|');
}

export function allSidecarPathsToStat(
  photos: readonly ResolvedFolderPhoto[],
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const photo of photos) {
    for (const p of sidecarPathsForPhoto(photo, ambiguousStemSidecarDirs)) out.add(p);
  }
  return [...out];
}
