/**
 * Central Lightroom write-back decision per photo (reject want + stars rating/lines).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cullPhoto } from '../src/cull/answer-photo.js';
import type { CullContext } from '../src/cull/persist.js';
import type { StageAnswerer } from '../src/cull/stage-models.js';
import { readCurrentStages, syncCurrentStages } from '../src/cull/stages.js';
import { factoryForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import type { PipelineSettingConfig } from '../src/cull/types.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { insertCullRun, upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { getLrWritebackSettings, patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { decideWriteback } from '../src/lightroom/writeback-decision.js';
import { nowIsoUtc } from '../src/utils/datetime.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
const MODEL_IDS = { culling_profile: 'base@1', score_forecast: 'new@1' };
const STRONG = [9, 9, 9, 9];
const PROFILE_FILTERS = [5, 5, 2, 3];
const KEY = 'photo-a';

let dir: string;
let db: Db;
let runId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-lrw-decision-'));
  db = initLibraryDb(join(dir, 'library.db'));
  seedCullingStagesOn(db);
  saveForecastQuestions(db, factoryForecastQuestions(db));
  syncCurrentStages(db, MODEL_IDS);
  runId = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
  patchLrWritebackSettings(db, { write_stars: true, write_reject: true });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeModels(levels10: number[], p8 = 0.5): StageAnswerer {
  const at = (l: number, n: number) => Array.from({ length: n }, (_, i) => (i === l - 1 ? 1 : 0));
  return {
    broken: false,
    async answer(_image, stages) {
      const answers: Record<string, Record<string, number[]>> = {};
      for (const s of stages) {
        if (s.kind === 'score_forecast') {
          answers[s.stageKey] = { 'framing-excusal': [1, 0], 'intensity-suggestion': [1 - p8, 0, 0, 0, 0, 0, 0, p8, 0, 0] };
          continue;
        }
        const own: Record<string, number[]> = {};
        for (const dim of DIMS) {
          const l = levels10[DIMS.indexOf(dim)]!;
          own[dim] = s.levelSet === '7' ? at(Math.round(1 + ((l - 1) * 6) / 9), 7) : at(l, 10);
        }
        answers[s.stageKey] = own;
      }
      return { answers, seconds: { culling_profile: 1, score_forecast: 1 }, producedBy: {} };
    },
  };
}

async function cull(imageKey: string, answerer: StageAnswerer, change?: (cfg: PipelineSettingConfig) => PipelineSettingConfig) {
  if (change) createPipelineSettingVersion(db, change(getCurrentPipelineSetting(db).config));
  const pipeline = getCurrentPipelineSetting(db);
  const ctx: CullContext = { stages: readCurrentStages(db).stages, pipeline, scoreForecastAvailable: true };
  await cullPhoto(db, ctx, answerer, { imageKey, sentByHand: false, runId, resolveImage: async () => '/cache/x.jpg' });
}

const decide = (imageKey: string, starsSlug: string | null = 'default') =>
  decideWriteback(db, getLrWritebackSettings(db), imageKey, starsSlug);

describe('decideWriteback reject.why', () => {
  it('setting_off when write reject is off', () => {
    patchLrWritebackSettings(db, { write_reject: false });
    expect(decide(KEY).reject).toEqual({ want: false, why: 'setting_off' });
  });

  it('no_verdict when the photo has no verdict', () => {
    expect(decide(KEY).reject).toEqual({ want: false, why: 'no_verdict' });
  });

  it('sent_by_hand when the photo was sent by hand', async () => {
    await cull(KEY, fakeModels(PROFILE_FILTERS));
    const { recordCullUserAction } = await import('../src/db/library/cull-user-actions.js');
    recordCullUserAction(db, KEY, 'sent_by_hand');
    db.prepare(`UPDATE cull_verdicts SET sent_by_hand = 0 WHERE image_key = ?`).run(KEY);
    expect(decide(KEY).reject).toEqual({ want: false, why: 'sent_by_hand' });
  });

  it('profile_off when the culling profile is off', async () => {
    await cull(KEY, fakeModels(PROFILE_FILTERS), (cfg) => ({ ...cfg, culling_profiles_enabled: false }));
    expect(decide(KEY).reject).toEqual({ want: false, why: 'profile_off' });
  });

  it('filtered when the culling profile rule filters', async () => {
    await cull(KEY, fakeModels(PROFILE_FILTERS));
    expect(decide(KEY).reject).toEqual({ want: true, why: 'filtered' });
  });

  it('void_frame when the frame is void', async () => {
    db.prepare(
      `INSERT INTO image_frame_substance (image_key, verdict, detector_version, judged_at, run_id)
       VALUES (?, 'void', 'test', ?, 1)`,
    ).run(KEY, nowIsoUtc());
    upsertCullVerdict(db, {
      imageKey: KEY,
      verdict: 'passed',
      filteredBy: null,
      filteredByStageKey: null,
      cullingProfileVerdict: null,
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: false,
      scoreForecastP8: null,
      pipelineSettingVersion: getCurrentPipelineSetting(db).version,
      stageVersionIds: [],
      runId: null,
    });
    expect(decide(KEY).reject).toEqual({ want: true, why: 'void_frame' });
  });

  it('passed when the photo is not filtered and the frame is not void', async () => {
    await cull(KEY, fakeModels(STRONG));
    expect(decide(KEY).reject).toEqual({ want: false, why: 'passed' });
  });
});

describe('decideWriteback stars.why', () => {
  it('no_profile when there is no stars profile slug', async () => {
    await cull(KEY, fakeModels(STRONG));
    expect(decide(KEY, null).stars).toMatchObject({ rating: null, strong: 0, profileName: null, why: 'no_profile' });
  });

  it('no_profile when the stars profile no longer exists', async () => {
    await cull(KEY, fakeModels(STRONG));
    expect(decide(KEY, 'missing-slug').stars).toMatchObject({
      rating: null,
      strong: 0,
      profileName: null,
      why: 'no_profile',
    });
  });

  it('profile_off when the culling profile is off', async () => {
    await cull(KEY, fakeModels(STRONG), (cfg) => ({ ...cfg, culling_profiles_enabled: false }));
    expect(decide(KEY).stars).toMatchObject({
      rating: null,
      strong: 0,
      profileName: 'Default culling profile',
      why: 'profile_off',
    });
  });

  it('void_frame when the frame is void and the culling profile is on', async () => {
    await cull(KEY, fakeModels(STRONG));
    db.prepare(
      `INSERT INTO image_frame_substance (image_key, verdict, detector_version, judged_at, run_id)
       VALUES (?, 'void', 'test', ?, 1)`,
    ).run(KEY, nowIsoUtc());
    expect(decide(KEY).stars).toMatchObject({
      rating: null,
      strong: 0,
      profileName: 'Default culling profile',
      why: 'void_frame',
    });
  });

  it('profile_off on a void frame when the culling profile is off (not void_frame)', async () => {
    await cull(KEY, fakeModels(STRONG));
    db.prepare(
      `INSERT INTO image_frame_substance (image_key, verdict, detector_version, judged_at, run_id)
       VALUES (?, 'void', 'test', ?, 1)`,
    ).run(KEY, nowIsoUtc());
    createPipelineSettingVersion(db, {
      ...getCurrentPipelineSetting(db).config,
      culling_profiles_enabled: false,
    });
    const stars = decide(KEY).stars;
    expect(stars.why).toBe('profile_off');
    expect(stars.rating).toBeNull();
    expect(decide(KEY).reject.why).toBe('profile_off');
    expect(decide(KEY).reject.want).toBe(false);
  });

  it('none when strong dimensions do not yield a rating', async () => {
    await cull(KEY, fakeModels([1, 1, 1, 1]));
    expect(decide(KEY).stars).toMatchObject({ rating: null, why: 'none' });
    expect(decide(KEY).stars.strong).toBe(0);
  });

  it('strong when answers yield a star rating', async () => {
    await cull(KEY, fakeModels(STRONG));
    expect(decide(KEY).stars).toMatchObject({ rating: 3, earnedRating: 3, strong: 4, why: 'strong' });
  });

  it('strong with rating null but the earned rating kept while write stars is off', async () => {
    await cull(KEY, fakeModels(STRONG));
    patchLrWritebackSettings(db, { write_stars: false });
    expect(decide(KEY).stars).toMatchObject({ rating: null, earnedRating: 3, strong: 4, why: 'strong' });
  });
});
