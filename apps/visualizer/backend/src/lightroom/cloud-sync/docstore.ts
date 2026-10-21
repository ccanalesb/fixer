/**
 * Push catalog stars and flags to Lightroom's cloud by appending a revision to the sync docstore.
 *
 * Classic only uploads changes it made itself: it writes each one as a new revision of the
 * photo's document in `<catalog> Sync.lrdata/<catalog id>/Managed Catalog.mcat`, and its
 * uploader sends every revision past `Oz-sendUpdatesContinueFrom`. A rating written straight
 * into `Adobe_images` is never turned into a revision, so it never leaves the machine. This
 * module writes that revision the way Classic does:
 *
 *   - a new `revs` row with a random uuid4 `revId` (the server keeps the client's id),
 *     parented on the winning revision, which stops being `current`
 *   - `docs.winningRevSequence` / `mostRecentRevSequence` point at it
 *   - `content` is the whole document re-encoded, stored as TEXT like Classic stores it
 *   - the catalog's `AgOzDocRevIds.currRevId` names the new revision, and the photo's
 *     `AgLibraryImageChangeCounter` is marked exported so Classic does not re-send it
 *
 * The `oz` label stays on the last revision the server confirmed; Classic moves it after the
 * upload. Same rule as the catalog: Lightroom must be closed while this writes.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Db } from '../../db/connection.js';
import { backupCatalogIfNeeded } from '../writer.js';
import { decodeMsgpack, encodeMsgpack, type MsgValue } from './msgpack.js';

export type CloudPushResult = 'pushed' | 'unchanged' | 'not_synced' | 'unreadable';

/** Which of the photo's catalog values to carry to the cloud. */
export interface CloudPushFields {
  rating: boolean;
  flag: boolean;
}

export interface CloudDocstore {
  path: string;
  db: Db;
  userId: string;
}

type Doc = Map<MsgValue, MsgValue>;

function catalogVariable(conn: Db, name: string): string | null {
  const table = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'Adobe_variablesTable'")
    .get();
  if (!table) return null;
  const row = conn.prepare('SELECT value FROM Adobe_variablesTable WHERE name = ?').get(name) as
    | { value: unknown }
    | undefined;
  return typeof row?.value === 'string' && row.value ? row.value : null;
}

/** `Managed Catalog.mcat` for this catalog, or null when the catalog does not sync. */
export function cloudDocstorePath(conn: Db, catalogPath: string): string | null {
  const catalogId = catalogVariable(conn, 'Adobe_lrMobileCatalogId');
  if (!catalogId) return null;
  const stem = basename(catalogPath, extname(catalogPath));
  const path = join(dirname(catalogPath), `${stem} Sync.lrdata`, catalogId, 'Managed Catalog.mcat');
  return existsSync(path) ? path : null;
}

/**
 * Open the docstore for writing, after the same once-a-day backup the catalog gets. The copy
 * goes next to the catalog's backups, not inside Lightroom's `Sync.lrdata`.
 */
export function openCloudDocstore(conn: Db, catalogPath: string): CloudDocstore | null {
  const path = cloudDocstorePath(conn, catalogPath);
  const userId = catalogVariable(conn, 'Adobe_lrMobileOzUserId');
  if (!path || !userId) return null;
  backupCatalogIfNeeded(path, { dir: dirname(catalogPath) });
  return { path, db: new Database(path), userId };
}

export function closeCloudDocstore(store: CloudDocstore | null): void {
  store?.db.close();
}

function stamps(now: Date): { seconds: string; millis: string } {
  const iso = now.toISOString();
  return { seconds: `${iso.slice(0, 19)}Z`, millis: iso };
}

function child(doc: Doc, key: string): Doc {
  const existing = doc.get(key);
  return existing instanceof Map ? existing : new Map();
}

/**
 * Set `doc[group][user]` to `{ date, [field]: value }` unless it already holds `value`.
 * `cleared` is what Lightroom writes when the user removes theirs (`0`, `'unflagged'`):
 * the entry stays, so a clear on a photo that never had one writes nothing.
 */
function setUserValue(
  doc: Doc,
  group: string,
  field: string,
  userId: string,
  value: number | string,
  cleared: number | string,
  date: string,
): boolean {
  const byUser = child(doc, group);
  const entry = byUser.get(userId);
  const current = entry instanceof Map ? entry.get(field) : undefined;
  if (current === undefined ? value === cleared : current === value) return false;
  byUser.set(userId, new Map<MsgValue, MsgValue>([['date', date], [field, value]]));
  doc.set(group, byUser);
  return true;
}

function flagName(pick: number | null): string {
  if (pick === 1) return 'pick';
  if (pick === -1) return 'reject';
  return 'unflagged';
}

/**
 * Make the photo's cloud document carry its catalog stars and/or flag.
 *
 * `unchanged` when the winning revision already holds them, which also covers a Classic edit
 * still waiting to upload: the new revision is chained on it. `unreadable` when the document
 * is in a state this does not handle (conflicted, deleted, or bytes that do not re-encode
 * identically); the photo is left alone.
 */
export function pushPhotoToCloud(
  store: CloudDocstore,
  conn: Db,
  imageId: number,
  fields: CloudPushFields,
  now: Date = new Date(),
): CloudPushResult {
  const asset = conn
    .prepare('SELECT ozAssetId FROM AgLibraryImageOzAssetIds WHERE image = ?')
    .get(imageId) as { ozAssetId: string } | undefined;
  if (!asset || asset.ozAssetId === 'pending') return 'not_synced';

  const live = conn.prepare('SELECT rating, pick FROM Adobe_images WHERE id_local = ?').get(imageId) as
    | { rating: number | null; pick: number | null }
    | undefined;
  if (!live) return 'not_synced';

  const docRow = store.db
    .prepare('SELECT localDocId, winningRevSequence, deleted, hasConflicts FROM docs WHERE fullDocId = ?')
    .get(asset.ozAssetId) as
    | { localDocId: number; winningRevSequence: number | null; deleted: number; hasConflicts: number }
    | undefined;
  if (!docRow || docRow.winningRevSequence === null) return 'not_synced';
  if (docRow.deleted || docRow.hasConflicts) return 'unreadable';

  const winning = store.db
    .prepare('SELECT CAST(content AS BLOB) AS content, current FROM revs WHERE sequence = ?')
    .get(docRow.winningRevSequence) as { content: Buffer | null; current: number } | undefined;
  if (!winning?.content || !winning.current) return 'unreadable';

  const bytes = new Uint8Array(winning.content);
  let doc: MsgValue;
  try {
    doc = decodeMsgpack(bytes);
  } catch {
    return 'unreadable';
  }
  if (!(doc instanceof Map) || !Buffer.from(encodeMsgpack(doc)).equals(winning.content)) return 'unreadable';

  const { seconds, millis } = stamps(now);
  let changed = false;
  if (fields.rating) {
    const rating = live.rating ? Math.round(live.rating) : 0;
    changed = setUserValue(doc, 'ratings', 'rating', store.userId, rating, 0, seconds) || changed;
  }
  if (fields.flag) {
    const flag = flagName(live.pick === null ? null : Math.round(live.pick));
    changed = setUserValue(doc, 'reviews', 'flag', store.userId, flag, 'unflagged', seconds) || changed;
  }
  if (!changed) return 'unchanged';
  doc.set('userUpdated', millis);

  const revId = randomUUID().replaceAll('-', '');
  const content = Buffer.from(encodeMsgpack(doc));
  store.db.transaction(() => {
    store.db.prepare('UPDATE revs SET current = 0 WHERE sequence = ?').run(docRow.winningRevSequence);
    const sequence = Number(
      store.db
        .prepare(
          `INSERT INTO revs (localDocId, revId, parentRevSequence, current, deleted, content)
           VALUES (?, ?, ?, 1, 0, CAST(? AS TEXT))`,
        )
        .run(docRow.localDocId, revId, docRow.winningRevSequence, content).lastInsertRowid,
    );
    store.db
      .prepare('UPDATE docs SET winningRevSequence = ?, mostRecentRevSequence = ? WHERE localDocId = ?')
      .run(sequence, sequence, docRow.localDocId);
  })();
  conn.transaction(() => {
    conn
      .prepare("UPDATE AgOzDocRevIds SET currRevId = ? WHERE localId = ? AND docType = 'asset'")
      .run(revId, imageId);
    conn
      .prepare('UPDATE AgLibraryImageChangeCounter SET lastSyncedChangeCounter = changeCounter WHERE image = ?')
      .run(imageId);
  })();
  return 'pushed';
}
