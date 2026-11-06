/**
 * Schema v20: sidecar stat signature for folder metadata-only sync.
 */
import type { Db } from '../connection.js';

export function upgradeFolderCatalogSidecarSigColumn(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(images)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('catalog_sidecar_sig')) {
    db.exec('ALTER TABLE images ADD COLUMN catalog_sidecar_sig TEXT');
  }
}
