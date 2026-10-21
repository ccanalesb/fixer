/**
 * Lightroom catalog write availability for keyword mutations.
 *
 * Availability is re-checked on every call rather than cached: the user can quit or
 * launch Lightroom between two requests, and a stale "available" would mean writing
 * into a catalog Lightroom has open.
 */
import { statSync } from 'node:fs';
import { config, loadLibraryConfig } from '../config.js';
import type { Db } from '../db/connection.js';
import {
  addKeywordByKey,
  backupCatalogIfNeeded,
  connectCatalog,
  CULL_KEYWORD,
  imageHasKeywordByKey,
  raiseIfCatalogLocked,
  removeKeywordByKey,
  type KeywordAddResult,
  type KeywordRemoveResult,
} from '../lightroom/writer.js';

export interface LrCatalogWriteStatus {
  available: boolean;
  path: string | null;
  reason: string | null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether the configured Lightroom catalog can accept keyword writes, and why not. */
export function describeLrCatalogWriteStatus(): LrCatalogWriteStatus {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const path = (cfg.catalogPath ?? '').trim();
  if (!path) {
    return { available: false, path: null, reason: 'No Lightroom catalog configured.' };
  }
  if (!isFile(path)) {
    return { available: false, path, reason: 'Lightroom catalog file not found.' };
  }
  try {
    raiseIfCatalogLocked(path);
  } catch (e) {
    return { available: false, path, reason: e instanceof Error ? e.message : String(e) };
  }
  return { available: true, path, reason: null };
}

/** Whether `lrt-cull` is on the image, or `null` when the catalog is unavailable. */
export function readCullKeywordPresent(library: Db, imageKey: string): boolean | null {
  const status = describeLrCatalogWriteStatus();
  if (!status.available || !status.path) return null;
  const conn = connectCatalog(status.path, library);
  try {
    return imageHasKeywordByKey(conn, imageKey, CULL_KEYWORD);
  } finally {
    conn.close();
  }
}

/**
 * Add `lrt-cull` to the image in the live catalog.
 *
 * Lock is checked again after availability, because Lightroom can open between the
 * two calls.
 */
export function writeCullKeyword(library: Db, imageKey: string): KeywordAddResult {
  const status = describeLrCatalogWriteStatus();
  if (!status.available || !status.path) {
    throw new RangeError(status.reason ?? 'Lightroom catalog unavailable.');
  }
  raiseIfCatalogLocked(status.path);
  backupCatalogIfNeeded(status.path);
  const conn = connectCatalog(status.path, library);
  try {
    return addKeywordByKey(conn, imageKey, CULL_KEYWORD);
  } finally {
    conn.close();
  }
}

/** Remove `lrt-cull` from the image in the live catalog. */
export function removeCullKeyword(library: Db, imageKey: string): KeywordRemoveResult {
  const status = describeLrCatalogWriteStatus();
  if (!status.available || !status.path) {
    throw new RangeError(status.reason ?? 'Lightroom catalog unavailable.');
  }
  raiseIfCatalogLocked(status.path);
  backupCatalogIfNeeded(status.path);
  const conn = connectCatalog(status.path, library);
  try {
    return removeKeywordByKey(conn, imageKey, CULL_KEYWORD);
  } finally {
    conn.close();
  }
}
