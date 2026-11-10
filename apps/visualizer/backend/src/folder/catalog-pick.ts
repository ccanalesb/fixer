/**
 * Map folder-catalog pick values between CatalogRecord and library.db integers.
 */
import type { CatalogPickFlag, CatalogRecord } from '../lightroom/reader.js';

export type CatalogPickWire = CatalogPickFlag;

export function pickForDb(record: CatalogRecord): CatalogPickWire {
  return record.pick;
}

export function assignCatalogPick(record: CatalogRecord, pick: CatalogPickWire): void {
  record.pick = pick;
}
