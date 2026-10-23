/**
 * A library whose culling has run before: seeded, with the culling profile and the Score forecast on.
 * A new library starts with both off (it has no models), so tests of the stages turn them on here.
 */
import type { Db } from '../../src/db/connection.js';
import { getCurrentPipelineSetting } from '../../src/db/library/cull-pipeline.js';
import { seedCullingDefaults } from '../../src/db/library/cull-profiles.js';

/** Seed the culling defaults, with both stages on in the pipeline setting's current version. */
export function seedCullingStagesOn(db: Db): void {
  seedCullingDefaults(db);
  const { version, config } = getCurrentPipelineSetting(db);
  const on = { ...config, culling_profiles_enabled: true, score_forecast: { ...config.score_forecast, enabled: true } };
  db.prepare('UPDATE cull_pipeline_settings SET config_json = ? WHERE version = ?').run(JSON.stringify(on), version);
}
