/**
 * Write-back into folder-catalog photo files (XMP sidecars and embedded metadata).
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExifTool } from 'exiftool-vendored';
import type { Db } from '../db/connection.js';
import { getImage } from '../db/library/catalog.js';
import { recordFolderCatalogFileSnapshot } from '../db/library/folder-sync.js';
import { libraryWrite } from '../db/library/write.js';
import type { PickRatingWriteResult } from '../lightroom/writer.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  type LivePickRating,
  type LiveWritebackCatalog,
  type WritebackCatalogWriter,
} from '../lightroom/writeback-catalog-writer.js';
import { createFolderExifSession } from './exif-read.js';
import { lstatPathsParallel } from './lstat-parallel.js';
import { atomicReplaceFileAsync, snapshotMtime, type MtimeGuard } from './xmp-atomic-write.js';
import { readFolderPhotoXmpMetadata, type FolderXmpMetadata } from './xmp-metadata.js';
import { resolveFolderWriteTargets } from './xmp-write-target.js';
import { resolveFolderPhotoAtPath, stemSidecarAmbiguousForDir } from './resolve-photo.js';
import type { ResolvedFolderPhoto } from './walk.js';

function liveFromMeta(meta: { rating: number; pick: number; keywords: string[] }): LiveWritebackCatalog {
  const auto_stars_keyword = meta.keywords.includes(AUTO_STARS_KEYWORD);
  const auto_reject_keyword = meta.keywords.includes(AUTO_REJECT_KEYWORD);
  if (meta.pick === -1) {
    return { pick: -1, rating: null, auto_stars_keyword, auto_reject_keyword };
  }
  if (meta.rating >= 1) {
    return { pick: 0, rating: meta.rating, auto_stars_keyword, auto_reject_keyword };
  }
  return { pick: 0, rating: null, auto_stars_keyword, auto_reject_keyword };
}

function pickRatingWriteResultFromAtomic(
  outcome: 'ok' | 'skipped_mtime' | 'readonly' | 'outside',
): PickRatingWriteResult | 'ok' {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'skipped_mtime') return 'mtime_conflict';
  if (outcome === 'readonly') return 'readonly_error';
  return 'skipped';
}

export class FolderWritebackCatalogWriter implements WritebackCatalogWriter {
  private readonly exif = createFolderExifSession();
  private readonly writeTool = new ExifTool({ maxProcs: 1 });
  private readonly liveByKey = new Map<string, LiveWritebackCatalog>();

  constructor(
    private readonly catalogRoot: string,
    private readonly library: Db,
  ) {}

  async prefetch(imageKeys: readonly string[]): Promise<void> {
    for (const imageKey of imageKeys) {
      if (this.liveByKey.has(imageKey)) continue;
      await this.readFreshLive(imageKey);
    }
  }

  async refreshLiveFromDisk(imageKey: string): Promise<LivePickRating | null> {
    const fresh = await this.readFreshLive(imageKey);
    if (!fresh) return null;
    return { pick: fresh.live.pick, rating: fresh.live.rating };
  }

  async close(): Promise<void> {
    await this.exif.end();
    await this.writeTool.end();
  }

  private resolvePhoto(imageKey: string): ResolvedFolderPhoto | null {
    const row = getImage(this.library, imageKey);
    if (!row?.filepath) return null;
    return resolveFolderPhotoAtPath(this.catalogRoot, String(row.filepath));
  }

  private ambiguousFor(photo: ResolvedFolderPhoto): Set<string> {
    const dir = dirname(photo.filepath);
    return stemSidecarAmbiguousForDir(dir, photo.stem) ? new Set([dir]) : new Set();
  }

  private async readFreshLive(
    imageKey: string,
  ): Promise<{ photo: ResolvedFolderPhoto; meta: FolderXmpMetadata; live: LiveWritebackCatalog } | null> {
    const photo = this.resolvePhoto(imageKey);
    if (!photo || !existsSync(photo.filepath)) return null;
    const ambiguous = this.ambiguousFor(photo);
    const sidecars = resolveFolderWriteTargets(photo, ambiguous).map((t) => t.path);
    const stats = await lstatPathsParallel([photo.filepath, ...sidecars], 4);
    const meta = await readFolderPhotoXmpMetadata(this.exif, photo, ambiguous, stats);
    const live = liveFromMeta(meta);
    this.liveByKey.set(imageKey, live);
    return { photo, meta, live };
  }

  readLive(imageKey: string): LiveWritebackCatalog | null {
    if (!this.liveByKey.has(imageKey)) return null;
    return this.liveByKey.get(imageKey) ?? null;
  }

  readPickRating(imageKey: string): LivePickRating | null {
    const live = this.readLive(imageKey);
    if (!live) return null;
    return { pick: live.pick, rating: live.rating };
  }

  hasAppStars(imageKey: string, rating: number): boolean {
    const live = this.readLive(imageKey);
    if (!live || live.rating !== rating) return false;
    return live.auto_stars_keyword;
  }

  hasAppReject(imageKey: string): boolean {
    const live = this.readLive(imageKey);
    if (!live || live.pick !== -1) return false;
    return live.auto_reject_keyword;
  }

  removeAutoStarsKeyword(imageKey: string): Promise<void> {
    return this.writeKeywordChange(imageKey, (kws) => kws.filter((k) => k !== AUTO_STARS_KEYWORD));
  }

  removeAutoRejectKeyword(imageKey: string): Promise<void> {
    return this.writeKeywordChange(imageKey, (kws) => kws.filter((k) => k !== AUTO_REJECT_KEYWORD));
  }

  writeStars(imageKey: string, rating: number): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    return this.writeRating(imageKey, rating, AUTO_STARS_KEYWORD);
  }

  writeReject(imageKey: string): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    return this.writeRating(imageKey, -1, AUTO_REJECT_KEYWORD);
  }

  clearStars(imageKey: string, writtenRating: number): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    const live = this.readLive(imageKey);
    if (!live || live.rating !== writtenRating) return 'skipped';
    return this.writeRating(imageKey, 0, null, { clearRating: true, removeKeyword: AUTO_STARS_KEYWORD });
  }

  clearReject(imageKey: string): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    const live = this.readLive(imageKey);
    if (!live || live.pick !== -1) return 'skipped';
    return this.writeRating(imageKey, 0, null, { clearRating: true, removeKeyword: AUTO_REJECT_KEYWORD });
  }

  replaceStars(
    imageKey: string,
    writtenRating: number,
    rating: number,
  ): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    const live = this.readLive(imageKey);
    if (!live || live.rating !== writtenRating || !live.auto_stars_keyword) return 'skipped';
    return this.writeRating(imageKey, rating, AUTO_STARS_KEYWORD);
  }

  undoStars(imageKey: string, beforeRating: number | null): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    const live = this.readLive(imageKey);
    if (!live?.auto_stars_keyword) return 'skipped';
    if (beforeRating == null || beforeRating === 0) {
      return this.writeRating(imageKey, 0, null, {
        clearRating: true,
        removeKeyword: AUTO_STARS_KEYWORD,
        forUndo: true,
      });
    }
    return this.writeRating(imageKey, beforeRating, null, {
      removeKeyword: AUTO_STARS_KEYWORD,
      forUndo: true,
    });
  }

  undoReject(imageKey: string, beforePick: number | null): PickRatingWriteResult | Promise<PickRatingWriteResult> {
    const live = this.readLive(imageKey);
    if (!live?.auto_reject_keyword) return 'skipped';
    if (beforePick === -1) return 'skipped';
    return this.writeRating(imageKey, 0, null, {
      clearRating: true,
      removeKeyword: AUTO_REJECT_KEYWORD,
      forUndo: true,
    });
  }

  imageLocalId(_imageKey: string): number | null {
    return null;
  }

  private async writeKeywordChange(imageKey: string, map: (kws: string[]) => string[]): Promise<void> {
    const fresh = await this.readFreshLive(imageKey);
    if (!fresh) return;
    const { photo, meta, live } = fresh;
    const rating = live.pick === -1 ? -1 : (live.rating ?? 0);
    const keywords = map(meta.keywords);
    const result = await this.applyToTargets(photo, rating, keywords, 'set');
    if (result === 'ok') {
      this.liveByKey.set(imageKey, liveFromMeta({ rating: meta.rating, pick: meta.pick, keywords }));
      this.recordSnapshot(imageKey, photo);
    }
  }

  private recordSnapshot(imageKey: string, photo: ResolvedFolderPhoto): void {
    const ambiguous = this.ambiguousFor(photo);
    libraryWrite(this.library, () =>
      recordFolderCatalogFileSnapshot(this.library, imageKey, photo, ambiguous),
    );
  }

  private async writeRating(
    imageKey: string,
    rating: number,
    keyword: string | null,
    opts?: { clearRating?: boolean; removeKeyword?: string; forUndo?: boolean },
  ): Promise<PickRatingWriteResult> {
    const fresh = await this.readFreshLive(imageKey);
    if (!fresh) return 'image_not_found';
    const { photo, meta, live } = fresh;

    if (!opts?.forUndo) {
      if (rating === -1) {
        if (live.rating != null && live.rating > 0) return 'skipped';
        if (live.pick != null && live.pick !== 0) return 'skipped';
      } else if (rating >= 1) {
        if (live.rating != null && live.rating > 0) return 'skipped';
        if (live.pick === -1) return 'skipped';
      }
    }

    let keywords = [...meta.keywords];
    const touchesSubject = Boolean(keyword || opts?.removeKeyword);
    if (opts?.removeKeyword) keywords = keywords.filter((k) => k !== opts.removeKeyword);
    if (keyword && !keywords.includes(keyword)) keywords = [...keywords, keyword];

    const writeRating = opts?.clearRating ? 0 : rating;
    const subjectMode = touchesSubject ? ('set' as const) : ('unchanged' as const);
    const result = await this.applyToTargets(photo, writeRating, keywords, subjectMode);
    const mapped = pickRatingWriteResultFromAtomic(result);
    if (mapped === 'ok') {
      this.liveByKey.set(
        imageKey,
        liveFromMeta({
          rating: writeRating === -1 ? 0 : writeRating,
          pick: writeRating === -1 ? -1 : 0,
          keywords,
        }),
      );
      this.recordSnapshot(imageKey, photo);
      return 'updated';
    }
    if (mapped === 'mtime_conflict' || mapped === 'readonly_error') return mapped;
    return 'skipped';
  }

  private guardsForTarget(photo: ResolvedFolderPhoto, targetPath: string): MtimeGuard[] {
    const guards: MtimeGuard[] = [];
    const photoGuard = snapshotMtime(photo.filepath);
    if (photoGuard) guards.push(photoGuard);
    if (existsSync(targetPath)) {
      const sideGuard = snapshotMtime(targetPath);
      if (sideGuard) guards.push(sideGuard);
    }
    return guards;
  }

  private async applyToTargets(
    photo: ResolvedFolderPhoto,
    rating: number,
    keywords: string[],
    subjectMode: 'unchanged' | 'set',
  ): Promise<'ok' | 'skipped_mtime' | 'readonly' | 'outside'> {
    const ambiguous = this.ambiguousFor(photo);
    const targets = resolveFolderWriteTargets(photo, ambiguous);
    for (const target of targets) {
      const guards = this.guardsForTarget(photo, target.path);
      const tags: Record<string, unknown> = { Rating: rating === 0 ? 0 : rating };
      if (subjectMode === 'set') {
        tags.Subject = keywords;
      }
      const outcome = await atomicReplaceFileAsync(this.catalogRoot, target.path, guards, async (tempPath) => {
        if (target.kind === 'embedded') {
          await this.writeTool.write(tempPath, tags, ['-overwrite_original']);
        } else {
          await this.writeTool.write(tempPath, tags);
        }
      });
      if (outcome !== 'ok') return outcome;
    }
    return 'ok';
  }
}

export async function openFolderWritebackWriterSession(
  catalogRoot: string,
  library: Db,
): Promise<{ writer: FolderWritebackCatalogWriter; close: () => Promise<void> }> {
  const writer = new FolderWritebackCatalogWriter(catalogRoot, library);
  return {
    writer,
    close: () => writer.close(),
  };
}
