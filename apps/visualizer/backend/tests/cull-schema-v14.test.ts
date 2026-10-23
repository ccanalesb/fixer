/**
 * Library schema 14 (#363): the pipeline setting's culling profile switches, and what the culling
 * profile says stored on each photo. Every stored pipeline setting is rewritten in place with both
 * switches on; every culling verdict, answer and Lightroom write-back row is kept.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION, upgradeLibrarySchema } from '../src/db/library/bootstrap.js';
import { getCullVerdict, upsertCullVerdict, type CullVerdictInput } from '../src/db/library/cull-verdicts.js';
import { getLrWritebackSettings, patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { upsertWritebackState } from '../src/db/library/lr-writeback-state.js';
import { desiredReject } from '../src/lightroom/writeback-shared.js';

const RULE = {
  level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 } },
  combine: 'every',
  filter_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
};
const pipelineV13 = (threshold: number, runAfter: boolean) => ({
  culling_profiles: [{ profile_slug: 'recipe-culling', rule: RULE, run_after_filtered: runAfter }],
  score_forecast: { enabled: true, threshold, high_from_level: 8, excused_at: 0.5, run_after_filtered: true },
});
const pipelineV14 = (threshold: number) => ({
  culling_profiles_enabled: true,
  culling_profiles_filter_enabled: true,
  culling_profiles: [{ profile_slug: 'recipe-culling', rule: RULE }],
  score_forecast: { enabled: true, threshold, high_from_level: 8, excused_at: 0.5 },
});

const verdict = (imageKey: string, v: Partial<CullVerdictInput>): CullVerdictInput => ({
  imageKey,
  verdict: 'passed',
  filteredBy: null,
  filteredByStageKey: null,
  cullingProfileVerdict: null,
  sentByHand: false,
  pendingStages: [],
  pendingReason: '',
  scoreForecastOff: false,
  scoreForecastP8: 0.4,
  pipelineSettingVersion: 2,
  stageVersionIds: [1, 2],
  runId: null,
  ...v,
});

/** A v13 library: no `culling_profile_verdict`, pipeline settings with `run_after_filtered`, every verdict kind. */
function writeV13Library(path: string): void {
  const db = initLibraryDb(path);
  upsertCullVerdict(db, verdict('a', { verdict: 'filtered', filteredBy: 'culling_profile', filteredByStageKey: 'culling_profile:recipe-culling:7' }));
  upsertCullVerdict(db, verdict('b', {}));
  upsertCullVerdict(db, verdict('c', { verdict: 'pending', pendingStages: ['score_forecast'], pendingReason: 'no_image', scoreForecastP8: null }));
  upsertCullVerdict(db, verdict('d', { verdict: 'filtered', filteredBy: 'score_forecast', filteredByStageKey: 'score_forecast', scoreForecastP8: 0.05 }));
  upsertCullVerdict(db, verdict('e', { verdict: 'passed', sentByHand: true, scoreForecastP8: 0.01 }));
  upsertCullVerdict(db, verdict('f', { verdict: 'passed', sentByHand: true, filteredByStageKey: null }));
  db.prepare("UPDATE cull_verdicts SET filtered_by = 'culling_profile' WHERE image_key = 'f'").run();
  patchLrWritebackSettings(db, { write_stars: true, write_reject: true });
  upsertWritebackState(db, {
    image_key: 'a',
    kind: 'reject',
    status: 'written',
    before_pick: 0,
    before_rating: 0,
    written_pick: -1,
    written_rating: null,
    stars_profile_version_id: null,
    written_at: '2026-10-20T00:00:00Z',
  });
  db.exec('ALTER TABLE cull_verdicts DROP COLUMN culling_profile_verdict');
  db.exec('DELETE FROM cull_pipeline_settings');
  db.prepare(
    `INSERT INTO cull_pipeline_settings (version, config_json, is_current, created_at, note)
     VALUES (1, ?, 0, '2026-10-20T00:00:00Z', 'default'), (2, ?, 1, '2026-10-20T00:00:00Z', 'threshold changed')`,
  ).run(JSON.stringify(pipelineV13(0.111, true)), JSON.stringify(pipelineV13(0.2, false)));
  db.pragma('user_version = 13');
  db.close();
}

const all = (d: Db, sql: string) => d.prepare(sql).all() as Record<string, unknown>[];
const columns = (d: Db, table: string) =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[]).map(
    (c) => `${c.name} ${c.type} ${c.notnull} ${c.pk}`,
  );
const VERDICT_COLUMNS = `image_key, verdict, filtered_by, filtered_by_stage_key, sent_by_hand, pending_stages, pending_reason,
  score_forecast_off, score_forecast_p8, pipeline_setting_version, stage_version_ids, run_id, decided_at`;

let dir: string;
let path: string;
let db: Db;
let before: Record<string, unknown>[];
let writebackBefore: Record<string, unknown>[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v14-'));
  path = join(dir, 'library.db');
  writeV13Library(path);
  const raw = openLibraryDb(path);
  before = all(raw, `SELECT ${VERDICT_COLUMNS} FROM cull_verdicts ORDER BY image_key`);
  writebackBefore = all(raw, 'SELECT * FROM lr_writeback_state ORDER BY image_key, kind');
  raw.close();
  db = initLibraryDb(path);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('library schema 14', () => {
  it('has the same cull_verdicts columns as a fresh library', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    const fresh = initLibraryDb(join(dir, 'fresh.db'));
    try {
      expect(columns(db, 'cull_verdicts')).toEqual(columns(fresh, 'cull_verdicts'));
    } finally {
      fresh.close();
    }
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('rewrites every pipeline-setting version in place: both culling profile switches on, no run_after_filtered', () => {
    const rows = all(db, 'SELECT version, config_json, is_current, note FROM cull_pipeline_settings ORDER BY version');
    expect(rows.map((r) => ({ ...r, config_json: JSON.parse(r.config_json as string) }))).toEqual([
      { version: 1, config_json: pipelineV14(0.111), is_current: 0, note: 'default' },
      { version: 2, config_json: pipelineV14(0.2), is_current: 1, note: 'threshold changed' },
    ]);
  });

  it('keeps every culling verdict as it was', () => {
    expect(all(db, `SELECT ${VERDICT_COLUMNS} FROM cull_verdicts ORDER BY image_key`)).toEqual(before);
  });

  it("stores the culling profile's verdict where it filtered the photo", () => {
    expect(all(db, 'SELECT image_key, culling_profile_verdict FROM cull_verdicts ORDER BY image_key')).toEqual([
      { image_key: 'a', culling_profile_verdict: 'filtered' },
      { image_key: 'b', culling_profile_verdict: null },
      { image_key: 'c', culling_profile_verdict: null },
      { image_key: 'd', culling_profile_verdict: null },
      { image_key: 'e', culling_profile_verdict: null },
      { image_key: 'f', culling_profile_verdict: 'filtered' },
    ]);
  });

  it('rejects the same photos in Lightroom as before, and keeps the write-back rows', () => {
    const settings = getLrWritebackSettings(db);
    expect(['a', 'b', 'c', 'd', 'e', 'f'].filter((k) => desiredReject(settings, getCullVerdict(db, k)))).toEqual(['a']);
    expect(all(db, 'SELECT * FROM lr_writeback_state ORDER BY image_key, kind')).toEqual(writebackBefore);
  });

  it('runs once: a second upgrade changes nothing', () => {
    const verdicts = all(db, 'SELECT * FROM cull_verdicts ORDER BY image_key');
    const settings = all(db, 'SELECT * FROM cull_pipeline_settings ORDER BY version');
    db.pragma('user_version = 13');
    upgradeLibrarySchema(db);
    expect(db.pragma('user_version', { simple: true })).toBe(LIBRARY_SCHEMA_VERSION);
    expect(all(db, 'SELECT * FROM cull_verdicts ORDER BY image_key')).toEqual(verdicts);
    expect(all(db, 'SELECT * FROM cull_pipeline_settings ORDER BY version')).toEqual(settings);
  });
});
