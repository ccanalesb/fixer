/**
 * Folder catalog image rows — updates during re-sync.
 */
import type { Db } from '../connection.js';
import type { CatalogRecord } from '../../lightroom/reader.js';
import { storeImagesBatch } from './catalog.js';
import { libraryWrite } from './write.js';

export interface FolderLibraryRow {
  key: string;
  id: string;
  filepath: string;
  file_size: number;
  date_taken: string;
  catalog_file_mtime: number | null;
  catalog_missing_since: string | null;
}

export function listFolderLibraryRows(db: Db): FolderLibraryRow[] {
  const rows = db
    .prepare(
      `SELECT key, id, filepath, file_size, date_taken, catalog_file_mtime, catalog_missing_since
       FROM images`,
    )
    .all() as FolderLibraryRow[];
  return rows.map((r) => ({
    ...r,
    id: r.id == null ? '' : String(r.id),
    file_size: Number(r.file_size ?? 0),
  }));
}

export function insertFolderRecords(db: Db, records: readonly CatalogRecord[], mtimeByKey: ReadonlyMap<string, number>): number {
  if (!records.length) return 0;
  storeImagesBatch(db, records);
  const stmt = db.prepare(
    'UPDATE images SET catalog_file_mtime = ?, catalog_missing_since = NULL WHERE key = ?',
  );
  for (const record of records) {
    const mtime = mtimeByKey.get(record.key);
    if (mtime != null) stmt.run(mtime, record.key);
  }
  return records.length;
}

export function updateFolderRecordInPlace(
  db: Db,
  key: string,
  record: CatalogRecord,
  catalogFileMtime: number,
  clearMissing: boolean,
): void {
  const pickVal = record.pick === true || Number(record.pick) === 1 ? 1 : 0;
  if (clearMissing) {
    db.prepare(
      `UPDATE images SET
        id = ?, filename = ?, filepath = ?, date_taken = ?, rating = ?, pick = ?,
        color_label = ?, keywords = ?, title = ?, caption = ?, copyright = ?,
        camera_make = ?, camera_model = ?, lens = ?, focal_length = ?, aperture = ?,
        shutter_speed = ?, iso = ?, gps_latitude = ?, gps_longitude = ?,
        width = ?, height = ?, file_size = ?, orientation = ?,
        catalog_file_mtime = ?, catalog_missing_since = NULL
       WHERE key = ?`,
    ).run(
      String(record.id),
      record.filename,
      record.filepath,
      record.date_taken,
      record.rating,
      pickVal,
      record.color_label,
      JSON.stringify(record.keywords ?? []),
      record.title,
      record.caption,
      record.copyright,
      record.camera_make,
      record.camera_model,
      record.lens,
      record.focal_length,
      record.aperture,
      record.shutter_speed,
      record.iso,
      record.gps_latitude,
      record.gps_longitude,
      record.width,
      record.height,
      record.file_size,
      record.orientation,
      catalogFileMtime,
      key,
    );
    return;
  }
  db.prepare(
    `UPDATE images SET
      id = ?, filename = ?, filepath = ?, date_taken = ?, rating = ?, pick = ?,
      color_label = ?, keywords = ?, title = ?, caption = ?, copyright = ?,
      camera_make = ?, camera_model = ?, lens = ?, focal_length = ?, aperture = ?,
      shutter_speed = ?, iso = ?, gps_latitude = ?, gps_longitude = ?,
      width = ?, height = ?, file_size = ?, orientation = ?,
      catalog_file_mtime = ?
     WHERE key = ?`,
  ).run(
    String(record.id),
    record.filename,
    record.filepath,
    record.date_taken,
    record.rating,
    pickVal,
    record.color_label,
    JSON.stringify(record.keywords ?? []),
    record.title,
    record.caption,
    record.copyright,
    record.camera_make,
    record.camera_model,
    record.lens,
    record.focal_length,
    record.aperture,
    record.shutter_speed,
    record.iso,
    record.gps_latitude,
    record.gps_longitude,
    record.width,
    record.height,
    record.file_size,
    record.orientation,
    catalogFileMtime,
    key,
  );
}

export function markFolderPhotosGone(db: Db, keys: readonly string[], sinceIso: string): number {
  if (!keys.length) return 0;
  const stmt = db.prepare(
    'UPDATE images SET catalog_missing_since = COALESCE(catalog_missing_since, ?) WHERE key = ?',
  );
  let n = 0;
  for (const key of keys) {
    n += stmt.run(sinceIso, key).changes;
  }
  return n;
}

export function applyFolderMove(
  db: Db,
  key: string,
  record: CatalogRecord,
  catalogFileMtime: number,
): void {
  updateFolderRecordInPlace(db, key, record, catalogFileMtime, true);
}
