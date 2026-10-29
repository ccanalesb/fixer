/**
 * Last address-probe result per provider in `visualizer.db`.
 */
import type { Db } from '../connection.js';

export interface ProviderAddressProbeRow {
  provider_id: string;
  answered: boolean;
  answered_url: string | null;
  probed_at: string;
  error: string | null;
}

export function ensureProviderProbeSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_address_probes (
      provider_id TEXT PRIMARY KEY,
      answered INTEGER NOT NULL,
      answered_url TEXT,
      probed_at TEXT NOT NULL,
      error TEXT
    );
  `);
}

export function getProviderAddressProbe(db: Db, providerId: string): ProviderAddressProbeRow | null {
  const row = db
    .prepare(
      `SELECT provider_id, answered, answered_url, probed_at, error
       FROM provider_address_probes WHERE provider_id = ?`,
    )
    .get(providerId) as
    | {
        provider_id: string;
        answered: number;
        answered_url: string | null;
        probed_at: string;
        error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    provider_id: row.provider_id,
    answered: row.answered !== 0,
    answered_url: row.answered_url,
    probed_at: row.probed_at,
    error: row.error,
  };
}

export function upsertProviderAddressProbe(
  db: Db,
  row: Omit<ProviderAddressProbeRow, 'provider_id'> & { provider_id: string },
): void {
  ensureProviderProbeSchema(db);
  db.prepare(
    `
    INSERT INTO provider_address_probes (provider_id, answered, answered_url, probed_at, error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      answered = excluded.answered,
      answered_url = excluded.answered_url,
      probed_at = excluded.probed_at,
      error = excluded.error
    `,
  ).run(
    row.provider_id,
    row.answered ? 1 : 0,
    row.answered_url,
    row.probed_at,
    row.error,
  );
}
