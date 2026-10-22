/**
 * Lightroom write-back under the pipeline setting's switches (#363): reject follows the culling
 * profile's rule whatever decided the photo; with the culling profile off, no stars and no reject.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cullPhoto, type LayaAnswerer } from '../src/cull/answer-photo.js';
import type { CullContext } from '../src/cull/persist.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import type { PipelineSettingConfig } from '../src/cull/types.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { getCullVerdict, insertCullRun } from '../src/db/library/cull-verdicts.js';
import { getLrWritebackSettings, patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { desiredReject, desiredStarsRating } from '../src/lightroom/writeback-shared.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
const MODEL_IDS = { base: 'base@1', new: 'new@1' };
const STRONG = [9, 9, 9, 9];
const PROFILE_FILTERS = [5, 5, 2, 3];

let dir: string;
let db: Db;
let runId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-switches-'));
  db = initLibraryDb(join(dir, 'library.db'));
  runId = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
  patchLrWritebackSettings(db, { write_stars: true, write_reject: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Profile levels on both level sets; P(≥ 8) as given. */
function fakeLaya(levels10: number[], p8 = 0.5): LayaAnswerer {
  const at = (l: number, n: number) => Array.from({ length: n }, (_, i) => (i === l - 1 ? 1 : 0));
  return {
    broken: false,
    async answer(_file, want = {}) {
      const base: Record<string, number[]> = {};
      for (const q of want.base ?? []) {
        const [set, dim] = q.split('#')[1]!.split('|');
        const l = levels10[DIMS.indexOf(dim!)]!;
        base[q] = set === '7' ? at(Math.round(1 + ((l - 1) * 6) / 9), 7) : at(l, 10);
      }
      const intensity = [1 - p8, 0, 0, 0, 0, 0, 0, p8, 0, 0];
      const neu = want.new ? { 'framing-excusal': [1, 0], 'intensity-suggestion': intensity } : null;
      return { answers: { base, new: neu }, seconds: { prep: 1, vision: 1, base: 1, new: 1, total: 4 } };
    },
  };
}

async function cull(imageKey: string, laya: LayaAnswerer, change?: (cfg: PipelineSettingConfig) => PipelineSettingConfig) {
  if (change) createPipelineSettingVersion(db, change(getCurrentPipelineSetting(db).config));
  const pipeline = getCurrentPipelineSetting(db);
  const ctx: CullContext = { stages: resolveCurrentStages(db, pipeline.config, MODEL_IDS), pipeline, scoreForecastAvailable: true };
  await cullPhoto(db, ctx, laya, { imageKey, sentByHand: false, runId, resolveImage: async () => '/cache/x.jpg' });
}

const settings = () => getLrWritebackSettings(db);
const reject = (key: string) => desiredReject(settings(), getCullVerdict(db, key));
const stars = (key: string) => desiredStarsRating(db, settings(), key, 'recipe-culling');

describe('Lightroom write-back under the switches', () => {
  it('everything on: reject where the rule filters, stars where the profile is strong', async () => {
    await cull('filtered', fakeLaya(PROFILE_FILTERS));
    await cull('strong', fakeLaya(STRONG));
    expect(reject('filtered')).toBe(true);
    expect(reject('strong')).toBe(false);
    expect(stars('strong')).toBe(3);
  });

  it("the culling profile's filter off: the photo passes, and is still rejected", async () => {
    await cull('a', fakeLaya(PROFILE_FILTERS), (cfg) => ({ ...cfg, culling_profiles_filter_enabled: false }));
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed' });
    expect(reject('a')).toBe(true);
  });

  it('the Score forecast decided: still rejected when the rule filters, not when it passes', async () => {
    const filterOff = (cfg: PipelineSettingConfig) => ({ ...cfg, culling_profiles_filter_enabled: false });
    await cull('rule-filters', fakeLaya(PROFILE_FILTERS, 0.01), filterOff);
    await cull('rule-passes', fakeLaya(STRONG, 0.01));
    expect(getCullVerdict(db, 'rule-filters')).toMatchObject({ verdict: 'filtered', filtered_by: 'score_forecast' });
    expect(getCullVerdict(db, 'rule-passes')).toMatchObject({ verdict: 'filtered', filtered_by: 'score_forecast' });
    expect(reject('rule-filters')).toBe(true);
    expect(reject('rule-passes')).toBe(false);
  });

  it('the culling profile off: no stars and no reject', async () => {
    await cull('strong', fakeLaya(STRONG));
    await cull('filtered', fakeLaya(PROFILE_FILTERS), (cfg) => ({ ...cfg, culling_profiles_enabled: false }));
    expect(reject('filtered')).toBe(false);
    expect(stars('strong')).toBeNull();
  });

  it('a photo sent by hand is never rejected', async () => {
    await cull('a', fakeLaya(PROFILE_FILTERS));
    db.prepare("UPDATE cull_verdicts SET sent_by_hand = 1 WHERE image_key = 'a'").run();
    expect(reject('a')).toBe(false);
  });
});
