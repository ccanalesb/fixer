/**
 * Folder catalog image rows — updates during re-sync.
 */
import type { Db } from '../connection.js';
import { statSync } from 'node:fs';
import type { CatalogRecord } from '../../lightroom/reader.js';
import { pickForDb } from '../../folder/catalog-pick.js';
import { storeImagesBatch } from './catalog.js';
import { libraryWrite } from './write.js';
import { sidecarPathsForPhoto, sidecarSignature } from '../../folder/xmp-sidecars.js';
import type { FileStatSnapshot } from '../../folder/lstat-parallel.js';
import type { ResolvedFolderPhoto } from '../../folder/walk.js';

export { pickForDb } from '../../folder/catalog-pick.js';

export interface FolderLibraryRow {
  key: string;
  id: string;
  filepath: string;
  file_size: number;
  date_taken: string;
  catalog_file_mtime: number | null;
  catalog_sidecar_sig: string | null;
  catalog_missing_since: string | null;
}

export function listFolderLibraryRows(db: Db): FolderLibraryRow[] {
  const rows = db
    .prepare(
      `SELECT key, id, filepath, file_size, date_taken, catalog_file_mtime, catalog_sidecar_sig,
              catalog_missing_since
       FROM images`,
    )
    .all() as FolderLibraryRow[];
  return rows.map((r) => ({
    ...r,
    id: r.id == null ? '' : String(r.id),
    file_size: Number(r.file_size ?? 0),
    catalog_sidecar_sig: r.catalog_sidecar_sig ?? null,
  }));
}

export function insertFolderRecords(
  db: Db,
  records: readonly CatalogRecord[],
  mtimeByKey: ReadonlyMap<string, number>,
  sidecarSigByKey?: ReadonlyMap<string, string>,
): number {
  if (!records.length) return 0;
  storeImagesBatch(db, records);
  const stmt = db.prepare(
    'UPDATE images SET catalog_file_mtime = ?, catalog_missing_since = NULL WHERE key = ?',
  );
  const sigStmt = sidecarSigByKey
    ? db.prepare('UPDATE images SET catalog_sidecar_sig = ? WHERE key = ?')
    : null;
  for (const record of records) {
    const mtime = mtimeByKey.get(record.key);
    if (mtime != null) stmt.run(mtime, record.key);
    const sig = sidecarSigByKey?.get(record.key);
    if (sig != null && sigStmt) sigStmt.run(sig, record.key);
  }
  return records.length;
}

export function updateFolderRecordInPlace(
  db: Db,
  key: string,
  record: CatalogRecord,
  catalogFileMtime: number,
  clearMissing: boolean,
  sidecarSig?: string | null,
): void {
  const pickVal = pickForDb(record);
  if (clearMissing) {
    db.prepare(
      `UPDATE images SET
        id = ?, filename = ?, filepath = ?, date_taken = ?, rating = ?, pick = ?,
        color_label = ?, keywords = ?, title = ?, caption = ?, copyright = ?,
        camera_make = ?, camera_model = ?, lens = ?, focal_length = ?, aperture = ?,
        shutter_speed = ?, iso = ?, gps_latitude = ?, gps_longitude = ?,
        width = ?, height = ?, file_size = ?, orientation = ?,
        catalog_file_mtime = ?, catalog_sidecar_sig = ?, catalog_missing_since = NULL
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
      sidecarSig ?? null,
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
      catalog_file_mtime = ?, catalog_sidecar_sig = ?
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
    sidecarSig ?? null,
    key,
  );
}

export function updateFolderMetadataOnly(
  db: Db,
  key: string,
  record: CatalogRecord,
  sidecarSig: string,
): void {
  const pickVal = pickForDb(record);
  db.prepare(
    `UPDATE images SET
      rating = ?, pick = ?, color_label = ?, keywords = ?, title = ?, caption = ?, copyright = ?,
      catalog_sidecar_sig = ?
     WHERE key = ?`,
  ).run(
    record.rating,
    pickVal,
    record.color_label,
    JSON.stringify(record.keywords ?? []),
    record.title,
    record.caption,
    record.copyright,
    sidecarSig,
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
  sidecarSig?: string | null,
): void {
  updateFolderRecordInPlace(db, key, record, catalogFileMtime, true, sidecarSig);
}

/** After write-back, match library file stats to disk so the next sync does not treat the write as an edit. */
export function recordFolderCatalogFileSnapshot(
  db: Db,
  imageKey: string,
  photo: ResolvedFolderPhoto,
  ambiguousStemSidecarDirs: ReadonlySet<string>,
): void {
  const sidecarPaths = sidecarPathsForPhoto(photo, ambiguousStemSidecarDirs);
  const statsByPath = new Map<string, FileStatSnapshot>();
  try {
    const st = statSync(photo.filepath);
    statsByPath.set(photo.filepath, { size: st.size, mtimeMs: st.mtimeMs, readable: true });
  } catch {
    return;
  }
  for (const p of sidecarPaths) {
    try {
      const st = statSync(p);
      statsByPath.set(p, { size: st.size, mtimeMs: st.mtimeMs, readable: true });
    } catch {
      statsByPath.set(p, { size: 0, mtimeMs: 0, readable: false });
    }
  }
  const photoStat = statsByPath.get(photo.filepath)!;
  const sideSig = sidecarSignature(sidecarPaths, statsByPath);
  db.prepare(
    `UPDATE images SET file_size = ?, catalog_file_mtime = ?, catalog_sidecar_sig = ? WHERE key = ?`,
  ).run(photoStat.size, photoStat.mtimeMs, sideSig, imageKey);
}
