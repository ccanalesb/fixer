import type { Db } from '../db/connection.js';
import { getWritebackState, upsertWritebackState } from '../db/library/lr-writeback-state.js';
import { libraryWrite } from '../db/library/write.js';
import type { WritebackKind } from './writeback-types.js';
import {
  backupCatalogIfNeeded,
  connectCatalog,
  raiseIfCatalogLocked,
  readPickRating,
  undoRejectFromCatalog,
  undoStarsFromCatalog,
} from './writer.js';
import { liveMatchesWritten } from './writeback-shared.js';

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
  const conn = connectCatalog(catalogPath);
  try {
    const live = readPickRating(conn, imageKey);
    if (!live || !liveMatchesWritten(kind, live, row)) {
      return { ok: false, reason: 'Lightroom no longer holds what the app wrote.' };
    }
    if (kind === 'reject') {
      undoRejectFromCatalog(conn, imageKey, row.before_pick);
    } else {
      undoStarsFromCatalog(conn, imageKey, row.before_rating);
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
    conn.close();
  }
}
