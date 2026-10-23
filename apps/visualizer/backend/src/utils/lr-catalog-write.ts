/**
 * Lightroom catalog write availability for the write-back.
 *
 * Availability is re-checked on every call rather than cached: the user can quit or
 * launch Lightroom between two requests, and a stale "available" would mean writing
 * into a catalog Lightroom has open.
 */
import { statSync } from 'node:fs';
import { config, loadLibraryConfig } from '../config.js';
import { raiseIfCatalogLocked } from '../lightroom/writer.js';

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
