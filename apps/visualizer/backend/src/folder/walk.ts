/**
 * Walk a folder catalog root and list photo files in sorted path order.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { isPhotoFilename, isJpegExtension, isRawExtension, photoExtension } from './photo-extensions.js';
import {
  isUnderSkippedRoot,
  shouldSkipEntryName,
  skipDirectory,
  skipRootsUnderCatalog,
} from './skip-paths.js';

export interface WalkedPhotoFile {
  absPath: string;
  relPath: string;
  dir: string;
  stem: string;
  ext: string;
}

export interface FolderWalkStats {
  photoCount: number;
  folderCount: number;
}

export interface ResolvedFolderPhoto {
  /** File stored on the row — RAW when paired, else the raster. */
  filepath: string;
  relPath: string;
  filename: string;
  stem: string;
}

function collectFiles(root: string): WalkedPhotoFile[] {
  const rootReal = resolve(root);
  const skipRoots = skipRootsUnderCatalog(rootReal);
  const out: WalkedPhotoFile[] = [];

  function visit(dir: string): void {
    if (skipDirectory(dir, skipRoots)) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const name of names) {
      if (shouldSkipEntryName(name)) continue;
      const abs = join(dir, name);
      if (isUnderSkippedRoot(abs, skipRoots)) continue;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!st.isFile() || !isPhotoFilename(name)) continue;
      const ext = photoExtension(name);
      const stem = basename(name, ext);
      out.push({
        absPath: abs,
        relPath: relative(rootReal, abs),
        dir,
        stem,
        ext,
      });
    }
  }

  visit(rootReal);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/** Group RAW + JPEG in the same directory into one logical photo. */
export function resolveFolderPhotos(files: WalkedPhotoFile[]): ResolvedFolderPhoto[] {
  const byDirStem = new Map<string, WalkedPhotoFile[]>();
  for (const file of files) {
    const key = `${file.dir}\0${file.stem.toLowerCase()}`;
    const group = byDirStem.get(key) ?? [];
    group.push(file);
    byDirStem.set(key, group);
  }

  const photos: ResolvedFolderPhoto[] = [];
  for (const group of byDirStem.values()) {
    group.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const raw = group.find((f) => isRawExtension(f.ext));
    const jpeg = group.find((f) => isJpegExtension(f.ext));
    if (raw && jpeg) {
      photos.push({
        filepath: raw.absPath,
        relPath: raw.relPath,
        filename: raw.stem,
        stem: raw.stem,
      });
      continue;
    }
    for (const f of group) {
      photos.push({
        filepath: f.absPath,
        relPath: f.relPath,
        filename: f.stem,
        stem: f.stem,
      });
    }
  }
  photos.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return photos;
}

export function walkFolderCatalog(root: string): { photos: ResolvedFolderPhoto[]; stats: FolderWalkStats } {
  const files = collectFiles(root);
  const photos = resolveFolderPhotos(files);
  const folderSet = new Set<string>();
  for (const f of files) folderSet.add(f.dir);
  return {
    photos,
    stats: { photoCount: photos.length, folderCount: folderSet.size },
  };
}

export function folderCatalogStats(root: string): FolderWalkStats {
  return walkFolderCatalog(root).stats;
}
