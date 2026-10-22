/**
 * Library schema 14 (#363): the pipeline setting's switches, and what the culling profile says stored
 * apart from what decided the photo.
 *
 * Every stored pipeline setting gets both culling profile switches on and loses `run_after_filtered`.
 * With every switch on, the decision is the one each version made before (a photo is filtered when the
 * culling profile's rule or the Score forecast filters it), so versions are rewritten in place and no
 * photo needs re-deciding. `culling_profile_verdict` is filled where the culling profile filtered the
 * photo — the only rows Lightroom reject read before — and the next re-decide fills the rest.
 */
import type { Db } from '../connection.js';

function tableExists(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

type Json = Record<string, unknown>;

function withoutRunAfterFiltered(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const { run_after_filtered: _dropped, ...rest } = value as Json;
  return rest;
}

/** A stored v13 config at v14; one already at v14 comes back unchanged. */
export function pipelineSettingV14(config: Json): Json {
  const { culling_profiles_enabled, culling_profiles_filter_enabled, culling_profiles, score_forecast, ...rest } = config;
  return {
    culling_profiles_enabled: culling_profiles_enabled ?? true,
    culling_profiles_filter_enabled: culling_profiles_filter_enabled ?? true,
    culling_profiles: Array.isArray(culling_profiles) ? culling_profiles.map(withoutRunAfterFiltered) : culling_profiles,
    score_forecast: withoutRunAfterFiltered(score_forecast),
    ...rest,
  };
}

/** Bring v13 cull tables to v14. Runs inside the caller's transaction. */
export function addCullingSwitches(db: Db): void {
  if (tableExists(db, 'cull_verdicts')) {
    if (!hasColumn(db, 'cull_verdicts', 'culling_profile_verdict')) {
      db.exec(
        "ALTER TABLE cull_verdicts ADD COLUMN culling_profile_verdict TEXT CHECK (culling_profile_verdict IN ('filtered','passed'))",
      );
    }
    db.exec(
      "UPDATE cull_verdicts SET culling_profile_verdict = 'filtered' WHERE filtered_by = 'culling_profile' AND culling_profile_verdict IS NULL",
    );
  }
  if (tableExists(db, 'cull_pipeline_settings')) {
    const update = db.prepare('UPDATE cull_pipeline_settings SET config_json = ? WHERE version = ?');
    for (const p of db.prepare('SELECT version, config_json FROM cull_pipeline_settings').all() as {
      version: number;
      config_json: string;
    }[]) {
      update.run(JSON.stringify(pipelineSettingV14(JSON.parse(p.config_json) as Json)), p.version);
    }
  }
}
