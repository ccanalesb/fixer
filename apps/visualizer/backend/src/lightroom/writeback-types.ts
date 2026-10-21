export type WritebackKind = 'stars' | 'reject';

export type WritebackStatus = 'pending' | 'written' | 'undone' | 'skipped';

export type StarsStrongFrom = '7' | '10' | 'every' | 'any';

export interface WritebackReconcileCounts {
  stars: { pending: number; written: number; skipped: number; image_not_found: number };
  reject: { pending: number; written: number; skipped: number; image_not_found: number };
  catalog_updated_stars: number;
  catalog_updated_reject: number;
  catalog_cleared_reject: number;
  /** Photos whose stars/flag this run carried to Lightroom's cloud, by outcome. */
  cloud: { pushed: number; not_synced: number; unreadable: number };
}

export const WRITE_CHUNK_SIZE = 500;
