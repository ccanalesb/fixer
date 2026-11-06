/**
 * Dry-run counts for turning on folder-catalog write-back switches.
 */
import type { Db } from '../db/connection.js';
import { getLrWritebackSettings, resolveStarsProfileSlug } from '../db/library/lr-writeback-settings.js';
import { CATALOG_PATH_META_KEY } from '../catalog-library.js';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import { decideWriteback } from '../lightroom/writeback-decision.js';
import { getWritebackState } from '../db/library/lr-writeback-state.js';
import { listVerdictImageKeys } from '../lightroom/writeback-shared.js';
import { createFolderExifSession } from './exif-read.js';
import { lstatPathsParallel } from './lstat-parallel.js';
import { readFolderPhotoXmpMetadata } from './xmp-metadata.js';
import { dryRunBreakdownForTargets, resolveFolderWriteTargets } from './xmp-write-target.js';
import { resolveFolderPhotoAtPath, stemSidecarAmbiguousForDir } from './resolve-photo.js';
import { getImage } from '../db/library/catalog.js';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WritebackTurnOnPreview {
  new_sidecar: number;
  update_sidecar: number;
  embedded: number;
}

function photoWouldWrite(
  db: Db,
  imageKey: string,
  kind: 'stars' | 'reject',
  meta: { rating: number; pick: number },
  decision: ReturnType<typeof decideWriteback>,
): boolean {
  const row = getWritebackState(db, imageKey, kind);
  if (row?.status === 'written' || row?.status === 'skipped') return false;
  if (meta.rating > 0 || meta.pick === -1) return false;
  if (kind === 'stars') {
    return decision.stars.rating != null;
  }
  if (!decision.reject.want) return false;
  return true;
}

export async function previewFolderWritebackTurnOn(
  db: Db,
  kind: 'stars' | 'reject',
): Promise<WritebackTurnOnPreview> {
  const catalogRoot = getLibraryMeta(db, CATALOG_PATH_META_KEY);
  if (!catalogRoot) return { new_sidecar: 0, update_sidecar: 0, embedded: 0 };

  const settings = getLrWritebackSettings(db);
  const starsSlug = resolveStarsProfileSlug(db, settings);
  const keys = listVerdictImageKeys(db);
  const session = createFolderExifSession();
  const totals = { new_sidecar: 0, update_sidecar: 0, embedded: 0 };

  try {
    for (const imageKey of keys) {
      const row = getImage(db, imageKey);
      if (!row?.filepath) continue;
      const photo = resolveFolderPhotoAtPath(catalogRoot, String(row.filepath));
      if (!photo || !existsSync(photo.filepath)) continue;
      const decision = decideWriteback(db, settings, imageKey, starsSlug);
      const ambiguous = stemSidecarAmbiguousForDir(dirname(photo.filepath))
        ? new Set([dirname(photo.filepath)])
        : new Set<string>();
      const stats = await lstatPathsParallel([photo.filepath], 2);
      const meta = await readFolderPhotoXmpMetadata(session, photo, ambiguous, stats);
      if (!photoWouldWrite(db, imageKey, kind, meta, decision)) continue;
      const breakdown = dryRunBreakdownForTargets(resolveFolderWriteTargets(photo, ambiguous));
      totals.new_sidecar += breakdown.new_sidecar;
      totals.update_sidecar += breakdown.update_sidecar;
      totals.embedded += breakdown.embedded;
    }
  } finally {
    await session.end();
  }
  return totals;
}
