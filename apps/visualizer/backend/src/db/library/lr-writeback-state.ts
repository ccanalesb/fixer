import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import type { WritebackKind, WritebackStatus } from '../../lightroom/writeback-types.js';
import { libraryWrite } from './write.js';

export interface LrWritebackStateRow {
  image_key: string;
  kind: WritebackKind;
  status: WritebackStatus;
  before_pick: number | null;
  before_rating: number | null;
  written_pick: number | null;
  written_rating: number | null;
  stars_profile_version_id: number | null;
  updated_at: string;
  written_at: string | null;
}

function toRow(raw: Record<string, unknown>): LrWritebackStateRow {
  return {
    image_key: String(raw.image_key),
    kind: raw.kind as WritebackKind,
    status: raw.status as WritebackStatus,
    before_pick: raw.before_pick === null || raw.before_pick === undefined ? null : Number(raw.before_pick),
    before_rating:
      raw.before_rating === null || raw.before_rating === undefined ? null : Number(raw.before_rating),
    written_pick: raw.written_pick === null || raw.written_pick === undefined ? null : Number(raw.written_pick),
    written_rating:
      raw.written_rating === null || raw.written_rating === undefined ? null : Number(raw.written_rating),
    stars_profile_version_id:
      raw.stars_profile_version_id === null || raw.stars_profile_version_id === undefined
        ? null
        : Number(raw.stars_profile_version_id),
    updated_at: String(raw.updated_at),
    written_at: raw.written_at === null || raw.written_at === undefined ? null : String(raw.written_at),
  };
}

export function getWritebackState(db: Db, imageKey: string, kind: WritebackKind): LrWritebackStateRow | null {
  const row = db
    .prepare('SELECT * FROM lr_writeback_state WHERE image_key = ? AND kind = ?')
    .get(imageKey, kind) as Record<string, unknown> | undefined;
  return row ? toRow(row) : null;
}

export function upsertWritebackState(db: Db, row: Omit<LrWritebackStateRow, 'updated_at'> & { updated_at?: string }): void {
  db.prepare(
    `INSERT INTO lr_writeback_state
       (image_key, kind, status, before_pick, before_rating, written_pick, written_rating,
        stars_profile_version_id, updated_at, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (image_key, kind) DO UPDATE SET
       status = excluded.status,
       before_pick = excluded.before_pick,
       before_rating = excluded.before_rating,
       written_pick = excluded.written_pick,
       written_rating = excluded.written_rating,
       stars_profile_version_id = excluded.stars_profile_version_id,
       updated_at = excluded.updated_at,
       written_at = excluded.written_at`,
  ).run(
    row.image_key,
    row.kind,
    row.status,
    row.before_pick,
    row.before_rating,
    row.written_pick,
    row.written_rating,
    row.stars_profile_version_id,
    row.updated_at ?? nowIsoUtc(),
    row.written_at,
  );
}

export function countWritebackByStatus(db: Db): Record<WritebackKind, Record<WritebackStatus, number>> {
  const rows = db
    .prepare(`SELECT kind, status, COUNT(*) AS n FROM lr_writeback_state GROUP BY kind, status`)
    .all() as { kind: WritebackKind; status: WritebackStatus; n: number }[];
  const out: Record<WritebackKind, Record<WritebackStatus, number>> = {
    stars: { pending: 0, written: 0, skipped: 0, undone: 0 },
    reject: { pending: 0, written: 0, skipped: 0, undone: 0 },
  };
  for (const r of rows) {
    out[r.kind][r.status] = r.n;
  }
  return out;
}

export function listWritebackKeysForKind(db: Db, kind: WritebackKind, status?: WritebackStatus): string[] {
  if (status) {
    return (
      db
        .prepare('SELECT image_key FROM lr_writeback_state WHERE kind = ? AND status = ?')
        .all(kind, status) as { image_key: string }[]
    ).map((r) => r.image_key);
  }
  return (db.prepare('SELECT image_key FROM lr_writeback_state WHERE kind = ?').all(kind) as { image_key: string }[]).map(
    (r) => r.image_key,
  );
}
