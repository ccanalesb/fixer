/**
 * Lightroom's cloud-sync docstore next to a fake catalog: `<stem> Sync.lrdata/<id>/Managed Catalog.mcat`
 * with the real `docs` / `revs` / `labels` schema, plus the catalog tables that point into it.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { decodeMsgpack, encodeMsgpack, type MsgValue } from '../../src/lightroom/cloud-sync/msgpack.js';

export const SYNC_CATALOG_ID = '83daa774782f4d5a84c1392e26b2f7d6';
export const SYNC_USER_ID = 'bb2a9e85783a97b9803d194c19b090c5';

export interface SyncedAsset {
  imageId: number;
  ozAssetId: string;
  /** Winning revision content; a minimal asset document when omitted. */
  doc?: Map<MsgValue, MsgValue>;
}

export function assetDoc(extra: [string, MsgValue][] = []): Map<MsgValue, MsgValue> {
  return new Map<MsgValue, MsgValue>([
    ['type', 'asset'],
    ['subtype', 'image'],
    ['userUpdated', '2026-10-05T03:23:32.678Z'],
    ['captureDate', '2026-10-04T16:47:07'],
    ...extra,
  ]);
}

export function syncDocstorePath(lrcatPath: string): string {
  const stem = basename(lrcatPath, extname(lrcatPath));
  return join(dirname(lrcatPath), `${stem} Sync.lrdata`, SYNC_CATALOG_ID, 'Managed Catalog.mcat');
}

/** Add cloud sync to a `makeFakeCatalog` catalog; every asset starts with one server-confirmed revision. */
export function addCloudSync(lrcatPath: string, assets: readonly SyncedAsset[]): string {
  const cat = new Database(lrcatPath);
  cat.exec(`
    CREATE TABLE IF NOT EXISTS Adobe_variablesTable (id_local INTEGER PRIMARY KEY, id_global, name, value);
    CREATE TABLE IF NOT EXISTS AgLibraryImageOzAssetIds (
      id_local NOT NULL DEFAULT 0, image NOT NULL, ozCatalogId NOT NULL, ozAssetId DEFAULT "pending",
      ownedByCatalog DEFAULT 'Y'
    );
    CREATE TABLE IF NOT EXISTS AgOzDocRevIds (localId NOT NULL, currRevId NOT NULL, docType NOT NULL,
      PRIMARY KEY (localId, docType));
    CREATE TABLE IF NOT EXISTS AgLibraryImageChangeCounter (image PRIMARY KEY, changeCounter DEFAULT 0,
      lastSyncedChangeCounter DEFAULT 0, changedAtTime DEFAULT '', localTimeOffsetSecs DEFAULT 0);
  `);
  const setVar = cat.prepare('INSERT INTO Adobe_variablesTable (name, value) VALUES (?, ?)');
  setVar.run('Adobe_lrMobileCatalogId', SYNC_CATALOG_ID);
  setVar.run('Adobe_lrMobileOzUserId', SYNC_USER_ID);

  const mcatPath = syncDocstorePath(lrcatPath);
  mkdirSync(dirname(mcatPath), { recursive: true });
  const m = new Database(mcatPath);
  m.exec(`
    CREATE TABLE docs( localDocId INTEGER PRIMARY KEY, fullDocId TEXT UNIQUE NOT NULL,
      winningRevSequence INTEGER REFERENCES revs( sequence ) ON DELETE SET NULL,
      mostRecentRevSequence INTEGER REFERENCES revs( sequence ) ON DELETE SET NULL,
      deleted BOOLEAN DEFAULT 0, hasConflicts BOOLEAN DEFAULT 0, annotation BLOB, spaceId TEXT, type TEXT,
      subtype TEXT );
    CREATE TABLE revs( sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      localDocId INTEGER NOT NULL REFERENCES docs( localDocId ) ON DELETE CASCADE,
      revId TEXT NOT NULL COLLATE BINARY, parentRevSequence INTEGER REFERENCES revs( sequence ) ON DELETE SET NULL,
      current BOOLEAN, deleted BOOLEAN DEFAULT 0, content BLOB );
    CREATE TABLE labels( localDocId INTEGER REFERENCES docs( localDocID ) ON DELETE CASCADE,
      revSequence INTEGER REFERENCES revs( sequence ) ON DELETE CASCADE, name STRING, UNIQUE( localDocId, name ) );
  `);
  for (const [i, a] of assets.entries()) {
    const localDocId = 1000 + i;
    const revId = `${a.ozAssetId.slice(0, 16)}0000000000000000`;
    cat.prepare('INSERT INTO AgLibraryImageOzAssetIds (image, ozCatalogId, ozAssetId) VALUES (?, ?, ?)').run(
      a.imageId,
      SYNC_CATALOG_ID,
      a.ozAssetId,
    );
    cat.prepare("INSERT INTO AgOzDocRevIds (localId, currRevId, docType) VALUES (?, ?, 'asset')").run(a.imageId, revId);
    cat
      .prepare('INSERT INTO AgLibraryImageChangeCounter (image, changeCounter, lastSyncedChangeCounter) VALUES (?, 50, 40)')
      .run(a.imageId);
    m.prepare("INSERT INTO docs (localDocId, fullDocId, type, subtype) VALUES (?, ?, 'asset', 'image')").run(
      localDocId,
      a.ozAssetId,
    );
    const seq = Number(
      m
        .prepare(
          'INSERT INTO revs (localDocId, revId, parentRevSequence, current, content) VALUES (?, ?, NULL, 1, CAST(? AS TEXT))',
        )
        .run(localDocId, revId, Buffer.from(encodeMsgpack(a.doc ?? assetDoc()))).lastInsertRowid,
    );
    m.prepare('UPDATE docs SET winningRevSequence = ?, mostRecentRevSequence = ? WHERE localDocId = ?').run(
      seq,
      seq,
      localDocId,
    );
    m.prepare("INSERT INTO labels (localDocId, revSequence, name) VALUES (?, ?, 'oz')").run(localDocId, seq);
  }
  m.close();
  cat.close();
  return mcatPath;
}

export interface CloudRev {
  sequence: number;
  revId: string;
  parent: number | null;
  current: number;
  contentType: string;
  doc: Map<MsgValue, MsgValue>;
}

export function readCloudRevs(mcatPath: string, ozAssetId: string): { winning: number; oz: number; revs: CloudRev[] } {
  const m = new Database(mcatPath, { readonly: true });
  try {
    const doc = m.prepare('SELECT localDocId, winningRevSequence FROM docs WHERE fullDocId = ?').get(ozAssetId) as {
      localDocId: number;
      winningRevSequence: number;
    };
    const oz = m.prepare("SELECT revSequence FROM labels WHERE localDocId = ? AND name = 'oz'").get(doc.localDocId) as {
      revSequence: number;
    };
    const rows = m
      .prepare(
        `SELECT sequence, revId, parentRevSequence AS parent, current, typeof(content) AS contentType,
                CAST(content AS BLOB) AS content
         FROM revs WHERE localDocId = ? ORDER BY sequence`,
      )
      .all(doc.localDocId) as (Omit<CloudRev, 'doc'> & { content: Buffer })[];
    return {
      winning: doc.winningRevSequence,
      oz: oz.revSequence,
      revs: rows.map(({ content, ...r }) => ({ ...r, doc: decodeMsgpack(new Uint8Array(content)) as Map<MsgValue, MsgValue> })),
    };
  } finally {
    m.close();
  }
}

/** `doc[group][SYNC_USER_ID][field]`, or undefined. */
export function userValue(doc: Map<MsgValue, MsgValue>, group: string, field: string): MsgValue | undefined {
  const byUser = doc.get(group);
  const entry = byUser instanceof Map ? byUser.get(SYNC_USER_ID) : undefined;
  return entry instanceof Map ? entry.get(field) : undefined;
}
