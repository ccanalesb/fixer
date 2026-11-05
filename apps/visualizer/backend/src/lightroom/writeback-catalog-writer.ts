/**
 * Write-back's view of the live catalog: read pick/rating/keywords, write stars or reject, undo.
 * Lightroom Classic `.lrcat` is the only implementation today; folder XMP will implement the same seam.
 */
import type { Db } from '../db/connection.js';
import type { PickRatingWriteResult } from './writer.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  clearRejectFromCatalog,
  clearStarsFromCatalog,
  connectCatalog,
  getImageLocalId,
  imageHasKeywordByKey,
  readPickRating,
  removeKeywordByKey,
  replaceRatingIfMatches,
  undoRejectFromCatalog,
  undoStarsFromCatalog,
  writeRejectToCatalog,
  writeStarsToCatalog,
  type LivePickRating,
} from './writer.js';

export type { LivePickRating };

export { AUTO_REJECT_KEYWORD, AUTO_STARS_KEYWORD } from './writer.js';

export interface LiveWritebackCatalog extends LivePickRating {
  auto_stars_keyword: boolean;
  auto_reject_keyword: boolean;
}

export interface WritebackCatalogWriter {
  readLive(imageKey: string): LiveWritebackCatalog | null;
  readPickRating(imageKey: string): LivePickRating | null;
  hasAppStars(imageKey: string, rating: number): boolean;
  hasAppReject(imageKey: string): boolean;
  removeAutoStarsKeyword(imageKey: string): void;
  removeAutoRejectKeyword(imageKey: string): void;
  writeStars(imageKey: string, rating: number): PickRatingWriteResult;
  writeReject(imageKey: string): PickRatingWriteResult;
  clearStars(imageKey: string, writtenRating: number): PickRatingWriteResult;
  clearReject(imageKey: string): PickRatingWriteResult;
  replaceStars(imageKey: string, writtenRating: number, rating: number): PickRatingWriteResult;
  undoStars(imageKey: string, beforeRating: number | null): PickRatingWriteResult;
  undoReject(imageKey: string, beforePick: number | null): PickRatingWriteResult;
  imageLocalId(imageKey: string): number | null;
}

export interface WritebackCatalogWriterSession {
  writer: WritebackCatalogWriter;
  /** Underlying `.lrcat` connection; reconcile/undo use it only for cloud docstore sync. */
  catalogConn: Db;
  close(): void;
}

class LrcatWritebackCatalogWriter implements WritebackCatalogWriter {
  constructor(private conn: Db) {}

  readLive(imageKey: string): LiveWritebackCatalog | null {
    const live = readPickRating(this.conn, imageKey);
    if (!live) return null;
    return {
      ...live,
      auto_stars_keyword: imageHasKeywordByKey(this.conn, imageKey, AUTO_STARS_KEYWORD),
      auto_reject_keyword: imageHasKeywordByKey(this.conn, imageKey, AUTO_REJECT_KEYWORD),
    };
  }

  readPickRating(imageKey: string): LivePickRating | null {
    return readPickRating(this.conn, imageKey);
  }

  hasAppStars(imageKey: string, rating: number): boolean {
    const live = readPickRating(this.conn, imageKey);
    if (!live || live.rating !== rating) return false;
    return imageHasKeywordByKey(this.conn, imageKey, AUTO_STARS_KEYWORD);
  }

  hasAppReject(imageKey: string): boolean {
    const live = readPickRating(this.conn, imageKey);
    if (!live || live.pick !== -1) return false;
    return imageHasKeywordByKey(this.conn, imageKey, AUTO_REJECT_KEYWORD);
  }

  removeAutoStarsKeyword(imageKey: string): void {
    removeKeywordByKey(this.conn, imageKey, AUTO_STARS_KEYWORD);
  }

  removeAutoRejectKeyword(imageKey: string): void {
    removeKeywordByKey(this.conn, imageKey, AUTO_REJECT_KEYWORD);
  }

  writeStars(imageKey: string, rating: number): PickRatingWriteResult {
    return writeStarsToCatalog(this.conn, imageKey, rating);
  }

  writeReject(imageKey: string): PickRatingWriteResult {
    return writeRejectToCatalog(this.conn, imageKey);
  }

  clearStars(imageKey: string, writtenRating: number): PickRatingWriteResult {
    return clearStarsFromCatalog(this.conn, imageKey, writtenRating);
  }

  clearReject(imageKey: string): PickRatingWriteResult {
    return clearRejectFromCatalog(this.conn, imageKey);
  }

  replaceStars(imageKey: string, writtenRating: number, rating: number): PickRatingWriteResult {
    return replaceRatingIfMatches(this.conn, imageKey, writtenRating, rating);
  }

  undoStars(imageKey: string, beforeRating: number | null): PickRatingWriteResult {
    return undoStarsFromCatalog(this.conn, imageKey, beforeRating);
  }

  undoReject(imageKey: string, beforePick: number | null): PickRatingWriteResult {
    return undoRejectFromCatalog(this.conn, imageKey, beforePick);
  }

  imageLocalId(imageKey: string): number | null {
    return getImageLocalId(this.conn, imageKey);
  }
}

export function openWritebackCatalogWriter(catalogPath: string, library: Db): WritebackCatalogWriterSession {
  const catalogConn = connectCatalog(catalogPath, library);
  const writer = new LrcatWritebackCatalogWriter(catalogConn);
  return {
    writer,
    catalogConn,
    close() {
      catalogConn.close();
    },
  };
}
