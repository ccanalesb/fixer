/**
 * Map folder-catalog pick values between CatalogRecord and library.db integers.
 */
import type { CatalogRecord } from '../lightroom/reader.js';

export type CatalogPickWire = -1 | 0 | 1;

export function pickForDb(record: CatalogRecord): CatalogPickWire {
  const raw = record.pick as boolean | number;
  if (Number(raw) === -1) return -1;
  if (raw === true || Number(raw) === 1) return 1;
  return 0;
}

export function assignCatalogPick(record: CatalogRecord, pick: CatalogPickWire): void {
  const target = record as CatalogRecord & { pick: boolean | number };
  if (pick === -1) target.pick = -1 as unknown as boolean;
  else if (pick === 1) target.pick = true;
  else target.pick = false;
}
