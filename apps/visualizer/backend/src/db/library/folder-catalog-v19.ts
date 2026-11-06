/**
 * Schema v19: folder catalog sync state on `images`.
 */
import type { Db } from '../connection.js';

export function upgradeFolderCatalogSyncColumns(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(images)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('catalog_missing_since')) {
    db.exec('ALTER TABLE images ADD COLUMN catalog_missing_since TEXT');
  }
  if (!names.has('catalog_file_mtime')) {
    db.exec('ALTER TABLE images ADD COLUMN catalog_file_mtime REAL');
  }
}
