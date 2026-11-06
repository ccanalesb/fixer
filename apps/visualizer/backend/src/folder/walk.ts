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

export interface FolderWalkResult {
  photos: ResolvedFolderPhoto[];
  stats: FolderWalkStats;
  /** Absolute paths of directories that could not be read. */
  unreadableDirectories: string[];
}

export interface ResolvedFolderPhoto {
  /** File stored on the row — RAW when paired, else the raster. */
  filepath: string;
  relPath: string;
  filename: string;
  stem: string;
}

function collectFiles(root: string): { files: WalkedPhotoFile[]; unreadableDirectories: string[] } {
  const rootReal = resolve(root);
  const skipRoots = skipRootsUnderCatalog(rootReal);
  const out: WalkedPhotoFile[] = [];
  const unreadableDirectories: string[] = [];

  function visit(dir: string): void {
    if (skipDirectory(dir, skipRoots)) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
    } catch {
      unreadableDirectories.push(dir);
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
  unreadableDirectories.sort((a, b) => a.localeCompare(b));
  return { files: out, unreadableDirectories };
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

export function walkFolderCatalog(root: string): FolderWalkResult {
  const walkStart = Date.now();
  const { files, unreadableDirectories } = collectFiles(root);
  const photos = resolveFolderPhotos(files);
  const folderSet = new Set<string>();
  for (const f of files) folderSet.add(f.dir);
  void walkStart;
  return {
    photos,
    stats: { photoCount: photos.length, folderCount: folderSet.size },
    unreadableDirectories,
  };
}

interface FolderWalkSummary {
  stats: FolderWalkStats;
  unreadableDirectories: string[];
}

const folderWalkSummaryCache = new Map<string, FolderWalkSummary>();

/** Drop cached folder walks (all roots, or one resolved path). */
export function invalidateFolderCatalogWalkCache(resolvedPath?: string): void {
  if (resolvedPath === undefined) {
    folderWalkSummaryCache.clear();
    return;
  }
  folderWalkSummaryCache.delete(resolve(resolvedPath));
}

/** Refresh the config-route cache after a sync walk. */
export function rememberFolderCatalogWalkSummary(
  root: string,
  summary: FolderWalkSummary,
): void {
  folderWalkSummaryCache.set(resolve(root), summary);
}

function folderWalkSummary(root: string): FolderWalkSummary {
  const key = resolve(root);
  const hit = folderWalkSummaryCache.get(key);
  if (hit) return hit;
  const { stats, unreadableDirectories } = walkFolderCatalog(root);
  const summary = { stats, unreadableDirectories };
  folderWalkSummaryCache.set(key, summary);
  return summary;
}

export function folderCatalogStats(root: string): FolderWalkStats {
  return folderWalkSummary(root).stats;
}

export function folderCatalogWalkDiagnostics(root: string): {
  stats: FolderWalkStats;
  unreadableDirectories: string[];
} {
  return folderWalkSummary(root);
}

/** Yield photo batches for streaming EXIF reads and DB writes. */
export function* batchResolvedPhotos(
  photos: readonly ResolvedFolderPhoto[],
  batchSize: number,
): Generator<ResolvedFolderPhoto[], void> {
  for (let i = 0; i < photos.length; i += batchSize) {
    yield photos.slice(i, i + batchSize);
  }
}
