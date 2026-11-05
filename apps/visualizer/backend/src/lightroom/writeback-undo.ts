import type { Db } from '../db/connection.js';
import { getWritebackState, upsertWritebackState } from '../db/library/lr-writeback-state.js';
import { libraryWrite } from '../db/library/write.js';
import type { WritebackKind } from './writeback-types.js';
import { backupCatalogIfNeeded, raiseIfCatalogLocked } from './writer.js';
import { closeCloudDocstore, openCloudDocstore, pushPhotoToCloud } from './cloud-sync/docstore.js';
import { liveMatchesWritten } from './writeback-shared.js';
import { openWritebackCatalogWriter } from './writeback-catalog-writer.js';

export function undoWritebackKind(
  db: Db,
  catalogPath: string,
  imageKey: string,
  kind: WritebackKind,
): { ok: boolean; reason?: string } {
  raiseIfCatalogLocked(catalogPath);
  backupCatalogIfNeeded(catalogPath);
  const row = getWritebackState(db, imageKey, kind);
  if (!row || row.status !== 'written') return { ok: false, reason: 'Nothing to undo.' };
  const session = openWritebackCatalogWriter(catalogPath, db);
  try {
    const live = session.writer.readLive(imageKey);
    const pickRating = live ? { pick: live.pick, rating: live.rating } : null;
    if (!pickRating || !liveMatchesWritten(kind, pickRating, row)) {
      return { ok: false, reason: 'Lightroom Classic no longer holds what the app wrote.' };
    }
    if (kind === 'reject') {
      session.writer.undoReject(imageKey, row.before_pick);
    } else {
      session.writer.undoStars(imageKey, row.before_rating);
    }
    const cloud = openCloudDocstore(session.catalogConn, catalogPath);
    const imageId = session.writer.imageLocalId(imageKey);
    try {
      if (cloud && imageId !== null) {
        pushPhotoToCloud(cloud, session.catalogConn, imageId, { rating: kind === 'stars', flag: kind === 'reject' });
      }
    } finally {
      closeCloudDocstore(cloud);
    }
    libraryWrite(db, () => {
      upsertWritebackState(db, {
        ...row,
        status: 'undone',
        written_pick: null,
        written_rating: null,
        written_at: null,
      });
    });
    return { ok: true };
  } finally {
    session.close();
  }
}
