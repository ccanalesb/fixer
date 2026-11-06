/**
 * Walk a folder catalog root and list photo files in sorted path order.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isPhotoFilename, isJpegExtension, isRawExtension, photoExtension } from './photo-extensions.js';
import { isUnderSkippedRoot, shouldSkipEntryName, skipRootsUnderCatalog } from './skip-paths.js';

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

export interface FolderWalkOptions {
  /** Asked before each directory is read; `true` abandons the walk. */
  shouldStop?: () => boolean | Promise<boolean>;
}

export interface ResolvedFolderPhoto {
  /** File stored on the row — RAW when paired, else the raster. */
  filepath: string;
  relPath: string;
  filename: string;
  stem: string;
  /** JPEG beside a paired RAW — pixels and secondary XMP source. */
  jpegFilepath?: string;
}

/** A photo file named `name` in `dir`, or null when the name is not a photo. */
export function walkedPhotoFile(rootReal: string, dir: string, name: string): WalkedPhotoFile | null {
  if (!isPhotoFilename(name)) return null;
  const abs = join(dir, name);
  const ext = photoExtension(name);
  // `ext` is lower-cased; slice by length so `IMG.CR2` has stem `IMG`.
  const stem = name.slice(0, name.length - ext.length);
  return { absPath: abs, relPath: relative(rootReal, abs), dir, stem, ext };
}

async function collectFiles(
  root: string,
  opts: FolderWalkOptions,
): Promise<{ files: WalkedPhotoFile[]; unreadableDirectories: string[] } | null> {
  const rootReal = resolve(root);
  const skipRoots = skipRootsUnderCatalog(rootReal);
  const out: WalkedPhotoFile[] = [];
  const unreadableDirectories: string[] = [];
  // Depth-first in sorted order: the stack holds directories still to read, last first.
  const pending: string[] = isUnderSkippedRoot(rootReal, skipRoots) ? [] : [rootReal];

  while (pending.length > 0) {
    if (opts.shouldStop && (await opts.shouldStop())) return null;
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unreadableDirectories.push(dir);
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (shouldSkipEntryName(entry.name)) continue;
      // Dirent types come from lstat, so a symlink is never a directory or file here.
      if (entry.isDirectory()) {
        const abs = join(dir, entry.name);
        if (!isUnderSkippedRoot(abs, skipRoots)) subdirs.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = walkedPhotoFile(rootReal, dir, entry.name);
      if (file) out.push(file);
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) pending.push(subdirs[i]!);
  }

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
        jpegFilepath: jpeg.absPath,
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

/** Walk `root`; null when `opts.shouldStop` abandoned it. */
export async function walkFolderCatalog(
  root: string,
  opts: FolderWalkOptions = {},
): Promise<FolderWalkResult | null> {
  const collected = await collectFiles(root, opts);
  if (!collected) return null;
  const { files, unreadableDirectories } = collected;
  const photos = resolveFolderPhotos(files);
  const folderSet = new Set<string>();
  for (const f of files) folderSet.add(f.dir);
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

/** One walk per root; concurrent requests share the walk in flight. */
const folderWalkSummaryCache = new Map<string, Promise<FolderWalkSummary>>();

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
  folderWalkSummaryCache.set(resolve(root), Promise.resolve(summary));
}

function folderWalkSummary(root: string): Promise<FolderWalkSummary> {
  const key = resolve(root);
  const hit = folderWalkSummaryCache.get(key);
  if (hit) return hit;
  const pending = walkFolderCatalog(root).then((walked) => ({
    stats: walked!.stats,
    unreadableDirectories: walked!.unreadableDirectories,
  }));
  folderWalkSummaryCache.set(key, pending);
  pending.catch(() => {
    if (folderWalkSummaryCache.get(key) === pending) folderWalkSummaryCache.delete(key);
  });
  return pending;
}

export async function folderCatalogStats(root: string): Promise<FolderWalkStats> {
  return (await folderWalkSummary(root)).stats;
}

export function folderCatalogWalkDiagnostics(root: string): Promise<FolderWalkSummary> {
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
