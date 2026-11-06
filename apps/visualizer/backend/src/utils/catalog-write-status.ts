/**
 * Whether the open catalog accepts write-back (Lightroom or folder).
 */
import { existsSync, statSync } from 'node:fs';
import { config, resolveConfiguredCatalogPath } from '../config.js';
import { CATALOG_KIND_META_KEY, CATALOG_PATH_META_KEY, inferCatalogKind } from '../catalog-library.js';
import { getLibraryMeta } from '../db/library/bootstrap.js';
import type { Db } from '../db/connection.js';
import { describeLrCatalogWriteStatus, type LrCatalogWriteStatus } from './lr-catalog-write.js';

export type { LrCatalogWriteStatus };

export function describeCatalogWriteStatus(db?: Db): LrCatalogWriteStatus {
  const configured = (resolveConfiguredCatalogPath(config.LT_CONFIG_YAML) ?? '').trim();
  const kindFromDb = db ? getLibraryMeta(db, CATALOG_KIND_META_KEY) : null;
  const kind = kindFromDb ?? (configured ? inferCatalogKind(configured) : 'lightroom');
  const pathFromDb = db ? getLibraryMeta(db, CATALOG_PATH_META_KEY) : null;
  const path = pathFromDb || configured || null;

  if (kind === 'folder') {
    if (!path) {
      return { available: false, path: null, reason: 'No folder catalog configured.' };
    }
    try {
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        return { available: false, path, reason: 'Folder catalog not found.' };
      }
    } catch {
      return { available: false, path, reason: 'Folder catalog not found.' };
    }
    return { available: true, path, reason: null };
  }

  return describeLrCatalogWriteStatus();
}
