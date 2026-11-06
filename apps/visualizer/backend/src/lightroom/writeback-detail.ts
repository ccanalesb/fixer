import { decideWriteback } from './writeback-decision.js';
import type { Db } from '../db/connection.js';
import { getWritebackState } from '../db/library/lr-writeback-state.js';
import { resolveStarsProfileSlug, type LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import { liveMatchesWritten, userChangedAfterWrite } from './writeback-shared.js';
import { openWritebackCatalogWriter, AUTO_REJECT_KEYWORD, AUTO_STARS_KEYWORD } from './writeback-catalog-writer.js';
import { CATALOG_KIND_META_KEY } from '../catalog-library.js';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import { openFolderWritebackWriterSession } from '../folder/xmp-writeback-writer.js';
import { basename, dirname } from 'node:path';
import { resolveFolderPhotoAtPath, stemSidecarAmbiguousForDir } from '../folder/resolve-photo.js';
import { resolveFolderWriteTargets } from '../folder/xmp-write-target.js';
import { getImage } from '../db/library/catalog.js';
import type { LrWritebackStateRow } from '../db/library/lr-writeback-state.js';

function starsBeforeLabel(row: LrWritebackStateRow | null): string | null {
  if (!row || row.status !== 'written') return null;
  if (row.before_rating == null || row.before_rating === 0) return 'before: no rating';
  return `before: ${row.before_rating}★`;
}

function folderWrittenFileLabel(catalogPath: string, db: Db, imageKey: string): string | null {
  const image = getImage(db, imageKey);
  if (!image?.filepath) return null;
  const photo = resolveFolderPhotoAtPath(catalogPath, String(image.filepath));
  if (!photo) return null;
  const dir = dirname(photo.filepath);
  const ambiguous = new Set<string>();
  if (stemSidecarAmbiguousForDir(dir)) ambiguous.add(dir);
  const targets = resolveFolderWriteTargets(photo, ambiguous);
  const target = targets[0];
  if (!target) return null;
  if (target.kind === 'embedded') return `embedded in ${basename(target.path)}`;
  return basename(target.path);
}

function pickWrittenRow(
  starsRow: LrWritebackStateRow | null,
  rejectRow: LrWritebackStateRow | null,
): LrWritebackStateRow | null {
  if (starsRow?.status === 'written') return starsRow;
  if (rejectRow?.status === 'written') return rejectRow;
  return null;
}

function strongDimensionsLine(decision: ReturnType<typeof decideWriteback>['stars']): string | null {
  switch (decision.why) {
    case 'no_profile':
      return null;
    case 'void_frame':
      return 'No stars: void frame';
    case 'profile_off':
      return 'No stars: the culling profile is off';
    case 'none':
      return `Strong dimensions (${decision.profileName}): none`;
    case 'strong':
      return `Strong dimensions (${decision.profileName}): ${decision.strong} strong → ${'★'.repeat(decision.earnedRating ?? 0)}`;
  }
}

export async function buildWritebackPhotoDetail(
  db: Db,
  catalogPath: string,
  imageKey: string,
  settings: LrWritebackSettings,
) {
  const starsSlug = resolveStarsProfileSlug(db, settings);
  const starsRow = getWritebackState(db, imageKey, 'stars');
  const rejectRow = getWritebackState(db, imageKey, 'reject');
  const decision = decideWriteback(db, settings, imageKey, starsSlug);

  const isFolder = getLibraryMeta(db, CATALOG_KIND_META_KEY) === 'folder';
  let live = null as ReturnType<
    Awaited<ReturnType<typeof openFolderWritebackWriterSession>>['writer']['readLive']
  >;
  const keywords: string[] = [];

  if (isFolder) {
    const folderSession = await openFolderWritebackWriterSession(catalogPath, db);
    try {
      await folderSession.writer.prefetch([imageKey]);
      live = folderSession.writer.readLive(imageKey);
      if (live?.auto_stars_keyword) keywords.push(AUTO_STARS_KEYWORD);
      if (live?.auto_reject_keyword) keywords.push(AUTO_REJECT_KEYWORD);
    } finally {
      await folderSession.close();
    }
  } else {
    const session = openWritebackCatalogWriter(catalogPath, db);
    try {
      live = session.writer.readLive(imageKey);
      if (live?.auto_stars_keyword) keywords.push(AUTO_STARS_KEYWORD);
      if (live?.auto_reject_keyword) keywords.push(AUTO_REJECT_KEYWORD);
    } finally {
      session.close();
    }
  }

  const pickRating = live ? { pick: live.pick, rating: live.rating } : null;
  const ratingUserChanged = starsRow && pickRating && userChangedAfterWrite('stars', pickRating, starsRow);
  const flagUserChanged = rejectRow && pickRating && userChangedAfterWrite('reject', pickRating, rejectRow);
  const writtenRow = pickWrittenRow(starsRow, rejectRow);
  const image = isFolder ? getImage(db, imageKey) : null;
  const userChangedFileLabel =
    image?.filepath != null ? basename(String(image.filepath)) : image?.filename ?? null;
  const userChanged = Boolean(ratingUserChanged || flagUserChanged);

  return {
    image_key: imageKey,
    rating: {
      live: pickRating?.rating ?? null,
      app_wrote: starsRow?.status === 'written',
      before_label: starsBeforeLabel(starsRow),
      undo_available:
        starsRow?.status === 'written' &&
        pickRating !== null &&
        liveMatchesWritten('stars', pickRating, starsRow) &&
        !ratingUserChanged,
      user_changed: Boolean(ratingUserChanged),
    },
    flag: {
      live_pick: pickRating?.pick ?? null,
      app_wrote_reject: rejectRow?.status === 'written',
      undo_available:
        rejectRow?.status === 'written' &&
        pickRating !== null &&
        liveMatchesWritten('reject', pickRating, rejectRow) &&
        !flagUserChanged,
      user_changed: Boolean(flagUserChanged),
    },
    keywords,
    strong_dimensions_line: strongDimensionsLine(decision.stars),
    written_at: writtenRow?.written_at ?? null,
    written_file_label:
      isFolder && writtenRow ? folderWrittenFileLabel(catalogPath, db, imageKey) : null,
    user_changed_message:
      isFolder && userChanged && userChangedFileLabel
        ? `Undone by you: what the app wrote is no longer in ${userChangedFileLabel}.`
        : null,
  };
}
