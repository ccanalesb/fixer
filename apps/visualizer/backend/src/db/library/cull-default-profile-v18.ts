/**
 * Library schema 18: the seeded culling profile's slug becomes `default` in every stored stage key and
 * profile slug, and `cull_profiles` loses `model` (each stage's model is in `culling_models`). Stage
 * versions keep their ids and hashes, which hold no slug, so every stored answer stays current. Run
 * details lose the keys no run writes any more.
 */
import type { Db } from '../connection.js';

const OLD_SLUG = 'recipe-culling';
const NEW_SLUG = 'default';
const OLD_PREFIX = `culling_profile:${OLD_SLUG}:`;
const NEW_PREFIX = `culling_profile:${NEW_SLUG}:`;
const DROPPED_DETAIL_KEYS = new Set(['laya_seconds', 'laya_started']);
const RENAMED_DETAIL_KEYS: Record<string, string> = { laya_new: 'score_forecast' };

const stageKey = (s: string) => (s.startsWith(OLD_PREFIX) ? NEW_PREFIX + s.slice(OLD_PREFIX.length) : s);

function rewriteDetail(value: unknown): unknown {
  if (typeof value === 'string') return stageKey(value);
  if (Array.isArray(value)) return value.map(rewriteDetail);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROPPED_DETAIL_KEYS.has(k)) continue;
    out[RENAMED_DETAIL_KEYS[k] ?? stageKey(k)] = rewriteDetail(v);
  }
  return out;
}

/** Bring v17 cull tables to v18. Runs inside the caller's transaction. */
export function upgradeDefaultProfileSlug(db: Db): void {
  const taken = db.prepare('SELECT 1 FROM cull_profiles WHERE slug = ?').get(NEW_SLUG);
  const seeded = db.prepare('SELECT 1 FROM cull_profiles WHERE slug = ?').get(OLD_SLUG);
  if (taken && seeded) {
    throw new Error(
      `library.db cannot be upgraded: a culling profile already has the slug ${NEW_SLUG}, which the seeded profile ` +
        `(${OLD_SLUG}) takes. Rename that profile first.`,
    );
  }
  db.prepare(
    `UPDATE cull_profiles SET slug = ?, source_filename = CASE source_filename WHEN ? THEN ? ELSE source_filename END
     WHERE slug = ?`,
  ).run(NEW_SLUG, `${OLD_SLUG}.json`, `${NEW_SLUG}.json`, OLD_SLUG);
  db.exec('ALTER TABLE cull_profiles DROP COLUMN model');

  const prefixed = (column: string) =>
    `${column} = CASE WHEN substr(${column}, 1, ${OLD_PREFIX.length}) = '${OLD_PREFIX}'
       THEN '${NEW_PREFIX}' || substr(${column}, ${OLD_PREFIX.length + 1}) ELSE ${column} END`;
  db.exec(`UPDATE cull_stage_versions SET ${prefixed('stage_key')}, profile_slug = '${NEW_SLUG}' WHERE profile_slug = '${OLD_SLUG}'`);
  db.exec(`UPDATE cull_verdicts SET ${prefixed('filtered_by_stage_key')} WHERE filtered_by_stage_key IS NOT NULL`);
  db.prepare(`UPDATE cull_verdicts SET pending_stages = replace(pending_stages, ?, ?) WHERE pending_stages LIKE ?`).run(
    `"${OLD_PREFIX}`,
    `"${NEW_PREFIX}`,
    `%"${OLD_PREFIX}%`,
  );
  db.prepare('UPDATE lr_writeback_settings SET stars_profile_slug = ? WHERE stars_profile_slug = ?').run(NEW_SLUG, OLD_SLUG);

  const setting = db.prepare('UPDATE cull_pipeline_settings SET config_json = ? WHERE version = ?');
  for (const p of db.prepare('SELECT version, config_json FROM cull_pipeline_settings').all() as {
    version: number;
    config_json: string;
  }[]) {
    const config = JSON.parse(p.config_json) as { culling_profiles?: { profile_slug?: string }[] };
    for (const c of config.culling_profiles ?? []) if (c.profile_slug === OLD_SLUG) c.profile_slug = NEW_SLUG;
    setting.run(JSON.stringify(config), p.version);
  }

  const run = db.prepare('UPDATE cull_runs SET detail_json = ? WHERE run_id = ?');
  for (const r of db.prepare('SELECT run_id, detail_json FROM cull_runs').all() as { run_id: number; detail_json: string }[]) {
    run.run(JSON.stringify(rewriteDetail(JSON.parse(r.detail_json))), r.run_id);
  }
}
