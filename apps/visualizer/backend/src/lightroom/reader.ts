/**
 * Reads image metadata out of a Lightroom `.lrcat`.
 *
 * The counterpart to `writer.ts`, and deliberately a separate connection function:
 * this one opens the catalog **read-only** so a browse or a sync cannot mutate a
 * file Lightroom owns. `writer.connectCatalog` opens it read-write and is guarded
 * by `raiseIfCatalogLocked` plus a backup; nothing here should ever reach for it.
 */
import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../db/connection.js';

/** Legacy `LIGHTRoom_*` env spellings still documented in the README for SMB/NAS catalogs. */
const LEGACY_ENV_ALIASES: Record<string, string> = {
  LIGHTROOM_CATALOG_READONLY_URI: 'LIGHTRoom_CATALOG_READONLY_URI',
  LIGHTROOM_CATALOG_LOCKING_MODE: 'LIGHTRoom_CATALOG_LOCKING_MODE',
};

function catalogEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value !== undefined) return value;
  const legacy = LEGACY_ENV_ALIASES[name];
  return legacy === undefined ? undefined : process.env[legacy];
}

/** True when `connectCatalogReadOnly` opens the catalog read-only (the default). */
export function catalogReadonlyUriEnabled(): boolean {
  return catalogEnv('LIGHTROOM_CATALOG_READONLY_URI') !== '0';
}

/**
 * The locking mode a catalog connection should ask for.
 *
 * Read-only opens default to NORMAL because `locking_mode=EXCLUSIVE` needs a write
 * lock and fails on some filesystems. Read-write opens default to EXCLUSIVE, which
 * is what lets SQLite use WAL without shared memory on NAS/SMB — the case where a
 * plain open fails with "unable to open database file".
 */
export function resolveCatalogLockingMode(readOnly: boolean): string {
  const raw = catalogEnv('LIGHTROOM_CATALOG_LOCKING_MODE');
  if (raw !== undefined) return raw.toUpperCase();
  return readOnly ? 'NORMAL' : 'EXCLUSIVE';
}

/** Apply the locking pragma when asked, falling back to NORMAL when it is refused. */
function applyLockingMode(conn: Db, lockingMode: string, readOnly: boolean): string {
  if (lockingMode !== 'EXCLUSIVE') return lockingMode;
  try {
    conn.pragma('locking_mode=EXCLUSIVE');
    return 'EXCLUSIVE';
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).toLowerCase();
    if (readOnly || msg.includes('disk i/o error')) return 'NORMAL';
    throw e;
  }
}

/**
 * Open a Lightroom catalog for reading.
 *
 * Set `LIGHTROOM_CATALOG_READONLY_URI=0` for a read-write open, and
 * `LIGHTROOM_CATALOG_LOCKING_MODE=EXCLUSIVE` to request exclusive locking on a
 * read-only open (with the NORMAL fallback above).
 *
 * The 30-second busy timeout matters: Lightroom holds the catalog while it is open,
 * and a scan that starts a second before Lightroom releases it should wait rather
 * than fail.
 */
export function connectCatalogReadOnly(catalogPath: string): Db {
  const readOnly = catalogReadonlyUriEnabled();
  const path = catalogPath.startsWith('~')
    ? join(homedir(), catalogPath.slice(1))
    : catalogPath;
  const conn = new Database(path, { readonly: readOnly, timeout: 30_000 });
  applyLockingMode(conn, resolveCatalogLockingMode(readOnly), readOnly);
  return conn;
}

/**
 * Zero-pad a Lightroom `captureTime`, leaving anything unparseable unchanged.
 *
 * Load-bearing rather than cosmetic: the first ten characters become the image key,
 * so a row reading `2024-1-5T…` has to produce `2024-01-05_…` or the sync stores a
 * duplicate of a photo that is already in the library.
 */
export function parseCatalogDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(dateStr);
  if (!m) return dateStr;
  const [, y, mo, d, hh, mi, ss] = m;
  const pad = (v: string, width: number): string => v.padStart(width, '0');
  return `${pad(y!, 4)}-${pad(mo!, 2)}-${pad(d!, 2)}T${pad(hh!, 2)}:${pad(mi!, 2)}:${pad(ss!, 2)}`;
}

/**
 * A GPS coordinate as a number, or `null`.
 *
 * An exact `0` also becomes `null`. Null Island is not in this catalog, and the
 * stored rows were written under this rule.
 */
export function parseGps(value: unknown): number | null {
  if (!value) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** The library key for a record: `YYYY-MM-DD_basename`. */
export function generateRecordKey(record: { date_taken?: string; filename?: string }): string {
  const dateTaken = record.date_taken ?? 'unknown';
  const datePart = dateTaken ? dateTaken.slice(0, 10) : 'unknown';
  return `${datePart}_${record.filename ?? 'unknown'}`;
}

/** A catalog pick flag, as Lightroom stores it: 1 pick, 0 unflagged, -1 reject. */
export type CatalogPickFlag = -1 | 0 | 1;

/** `Adobe_images.pick` as a record field: reject stays -1 rather than collapsing to a pick. */
export function lrPickFromCatalog(pickFlag: unknown): CatalogPickFlag {
  if (pickFlag === null || pickFlag === undefined) return 0;
  if (Number(pickFlag) === -1) return -1;
  return Number(pickFlag) === 1 ? 1 : 0;
}

/** One catalog image, in the shape `store_image` writes to `library.db`. */
export interface CatalogRecord {
  id: number;
  key: string;
  filename: string;
  filepath: string;
  date_taken: string;
  rating: number;
  pick: CatalogPickFlag;
  color_label: string;
  keywords: string[];
  title: string;
  caption: string;
  copyright: string;
  camera_make: string;
  camera_model: string;
  lens: string;
  focal_length: string | number;
  aperture: string | number;
  shutter_speed: string | number;
  iso: number;
  gps_latitude: number | null;
  gps_longitude: number | null;
  width: number;
  height: number;
  file_size: number;
  /** `Adobe_images.orientation`, e.g. `AB` (as stored) or `BC` (turned clockwise). */
  orientation: string | null;
}

/**
 * The metadata join. `AgLibraryFile` is the anchor because `catalog_sync` diffs on
 * `AgLibraryFile.id_local` — note that this is a *different* id from the
 * `Adobe_images.id_local` the keyword writer links against.
 */
const IMAGE_METADATA_SQL = `
    SELECT
        f.id_local as file_id,
        f.baseName as filename,
        f.extension as extension,
        fl.pathFromRoot as folder_path,
        rf.absolutePath as root_path,

        img.rating as rating,
        img.pick as pick_flag,
        img.colorLabels as color_label,
        img.fileWidth as width,
        img.fileHeight as height,
        img.orientation as orientation,

        img.captureTime as date_taken,

        exif.aperture as aperture,
        exif.focalLength as focal_length,
        exif.shutterSpeed as shutter_speed,
        exif.isoSpeedRating as iso,
        exif.gpsLatitude as gps_latitude,
        exif.gpsLongitude as gps_longitude,

        iptc.caption as caption,
        iptc.copyright as copyright

    FROM AgLibraryFile f
    JOIN AgLibraryFolder fl ON f.folder = fl.id_local
    JOIN AgLibraryRootFolder rf ON fl.rootFolder = rf.id_local
    LEFT JOIN Adobe_images img ON f.id_local = img.rootFile
    LEFT JOIN AgHarvestedExifMetadata exif ON img.id_local = exif.image
    LEFT JOIN AgLibraryIPTC iptc ON img.id_local = iptc.image
    WHERE f.id_local = ?
`;

/**
 * Keywords linked to a catalog file.
 *
 * `AgLibraryKeywordImage.image` references `Adobe_images.id_local`, not
 * `AgLibraryFile.id_local`. Join through `Adobe_images.rootFile`, as `writer.ts` does.
 */
export function getKeywordsForFileId(conn: Db, fileId: number): string[] {
  const rows = conn
    .prepare(
      `SELECT k.name AS name
       FROM AgLibraryKeywordImage ki
       JOIN AgLibraryKeyword k ON ki.tag = k.id_local
       JOIN Adobe_images ai ON ai.id_local = ki.image
       WHERE ai.rootFile = ?`,
    )
    .all(fileId) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Fetch one image by `AgLibraryFile.id_local`, or `null` when the file is gone.
 *
 * Use `|| fallback`, not `?? fallback`: a zero focal length must read as `''`, and
 * existing catalog rows were written under that rule.
 */
export function getImageById(conn: Db, imageId: number): CatalogRecord | null {
  const row = conn.prepare(IMAGE_METADATA_SQL).get(imageId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const filename = (row['filename'] as string) || '';
  const extension = (row['extension'] as string) || '';
  const rootPath = (row['root_path'] as string) || '';
  const folderPath = (row['folder_path'] as string) || '';
  const record: CatalogRecord = {
    id: row['file_id'] as number,
    key: '',
    filename,
    // Concatenated without a separator, because Lightroom stores both halves with
    // their trailing slash already on.
    filepath: rootPath + folderPath + (extension ? `${filename}.${extension}` : filename),
    date_taken: parseCatalogDate(row['date_taken'] as string | null) ?? '',
    rating: (row['rating'] as number) || 0,
    pick: lrPickFromCatalog(row['pick_flag']),
    color_label: (row['color_label'] as string) || '',
    keywords: getKeywordsForFileId(conn, imageId),
    title: '',
    caption: (row['caption'] as string) || '',
    copyright: (row['copyright'] as string) || '',
    camera_make: '',
    camera_model: '',
    lens: '',
    focal_length: (row['focal_length'] as number) || '',
    aperture: (row['aperture'] as number) || '',
    shutter_speed: (row['shutter_speed'] as number) || '',
    iso: (row['iso'] as number) || 0,
    gps_latitude: parseGps(row['gps_latitude']),
    gps_longitude: parseGps(row['gps_longitude']),
    width: (row['width'] as number) || 0,
    height: (row['height'] as number) || 0,
    file_size: 0,
    orientation: (row['orientation'] as string | null) ?? null,
  };
  record.key = generateRecordKey(record);
  return record;
}

/** How many files the catalog holds, for `scan`'s pre-count. */
export function getImageCount(conn: Db): number {
  const row = conn.prepare('SELECT COUNT(*) AS n FROM AgLibraryFile').get() as { n: number };
  return Number(row.n);
}

/**
 * Every image with full metadata, oldest id first, for a full `scan`.
 *
 * A row that has vanished between the id listing and its fetch contributes
 * nothing, rather than failing the scan.
 */
export function getImageRecords(conn: Db, limit?: number | null): CatalogRecord[] {
  const rows = (
    limit
      ? conn
          .prepare('SELECT f.id_local AS id FROM AgLibraryFile f ORDER BY f.id_local LIMIT ?')
          .all(limit)
      : conn.prepare('SELECT f.id_local AS id FROM AgLibraryFile f ORDER BY f.id_local').all()
  ) as { id: number }[];

  const records: CatalogRecord[] = [];
  for (const row of rows) {
    const record = getImageById(conn, Number(row.id));
    if (record) records.push(record);
  }
  return records;
}

/** `Adobe_images.orientation` for every catalog file, in one query. */
export function listCatalogOrientations(conn: Db): Map<number, string | null> {
  const rows = conn
    .prepare(
      `SELECT f.id_local AS id, img.orientation AS orientation
       FROM AgLibraryFile f LEFT JOIN Adobe_images img ON img.rootFile = f.id_local`,
    )
    .all() as { id: number; orientation: string | null }[];
  return new Map(rows.map((r) => [Number(r.id), r.orientation ?? null]));
}

/** Every `AgLibraryFile.id_local` in the catalog — the set-difference input. */
export function listCatalogFileIds(conn: Db): number[] {
  const rows = conn.prepare('SELECT f.id_local AS id FROM AgLibraryFile f').all() as {
    id: number;
  }[];
  return rows.map((r) => Number(r.id));
}
