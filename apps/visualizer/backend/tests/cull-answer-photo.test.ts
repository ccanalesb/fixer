/**
 * One photo through culling (`cull/answer-photo.ts`) and the choice of photos to cull
 * (`cull/select.ts`), on a temp library and fake stage models.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cullPhoto } from '../src/cull/answer-photo.js';
import type { CullContext } from '../src/cull/persist.js';
import { selectPhotosToCull } from '../src/cull/select.js';
import { CullingStageError, StageCallError, type StageAnswerer } from '../src/cull/stage-models.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { layaNewForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import type { PipelineSettingConfig, ResolvedStage } from '../src/cull/types.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { getCullVerdict, insertCullRun } from '../src/db/library/cull-verdicts.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
const MODEL_IDS = { culling_profile: 'base@1', score_forecast: 'new@1' };

let dir: string;
let db: Db;
let runId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-photo-'));
  db = initLibraryDb(join(dir, 'library.db'));
  seedCullingStagesOn(db);
  saveForecastQuestions(db, layaNewForecastQuestions(db));
  runId = insertCullRun(db, { kind: 'job', jobId: null, pipelineSettingVersion: 1 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function context(change?: (cfg: PipelineSettingConfig) => PipelineSettingConfig): CullContext {
  if (change) createPipelineSettingVersion(db, change(getCurrentPipelineSetting(db).config));
  const pipeline = getCurrentPipelineSetting(db);
  return { stages: resolveCurrentStages(db, pipeline.config, MODEL_IDS), pipeline, scoreForecastAvailable: true };
}

const forecastOff = (cfg: PipelineSettingConfig): PipelineSettingConfig => ({
  ...cfg,
  score_forecast: { ...cfg.score_forecast, enabled: false },
});
const profilesOff = (cfg: PipelineSettingConfig): PipelineSettingConfig => ({
  ...cfg,
  culling_profiles_enabled: false,
  score_forecast: { ...cfg.score_forecast, enabled: true },
});

/** Fake stage models: profile levels per photo on both level sets, P(≥ 8) 0.5. */
function fakeLaya(levels10: number[], opts: { fail?: 'answer' | 'down' | 'setup' | 'read' } = {}) {
  const calls: string[][] = [];
  const at = (l: number, n: number) => Array.from({ length: n }, (_, i) => (i === l - 1 ? 1 : 0));
  const laya: StageAnswerer & { calls: string[][]; broken: boolean } = {
    calls,
    broken: false,
    async answer(_image, stages: readonly ResolvedStage[]) {
      calls.push(stages.map((s) => s.stageKey));
      if (opts.fail === 'setup') throw new CullingStageError('culling_profile', 'not_listed', 'Culling profile: not listed');
      if (opts.fail === 'read') throw new Error('ENOENT: no such file');
      if (opts.fail) {
        if (opts.fail === 'down') laya.broken = true;
        throw new StageCallError('culling_profile', opts.fail === 'down' ? 'down' : 'http', 'Culling profile: boom');
      }
      const answers: Record<string, Record<string, number[]>> = {};
      const producedBy: Record<string, string> = {};
      for (const s of stages) {
        producedBy[s.stageKey] = s.kind === 'score_forecast' ? 'http://elsewhere:9000' : 'this_app';
        if (s.kind === 'score_forecast') {
          answers[s.stageKey] = { 'framing-excusal': [1, 0], 'intensity-suggestion': [0.5, 0, 0, 0, 0, 0, 0, 0.5, 0, 0] };
          continue;
        }
        answers[s.stageKey] = Object.fromEntries(
          DIMS.map((dim, i) => [dim, s.levelSet === '7' ? at(Math.round(1 + ((levels10[i]! - 1) * 6) / 9), 7) : at(levels10[i]!, 10)]),
        );
      }
      const kinds = new Set(stages.map((s) => s.kind));
      const seconds = Object.fromEntries([...kinds].map((k) => [k, 1]));
      return { answers, seconds, producedBy };
    },
  };
  return laya;
}

const S7 = 'culling_profile:recipe-culling:7';
const S10 = 'culling_profile:recipe-culling:10';

const image = async () => '/cache/a.jpg';
const noImage = async () => null;

describe('cullPhoto', () => {
  it('answers every missing stage, and stores it with the endpoint that answered each', async () => {
    const ctx = context();
    const laya = fakeLaya([5, 5, 6, 6]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(r.outcome).toBe('culled');
    expect(laya.calls).toEqual([[S7, S10, 'score_forecast']]);
    expect(r.answeredStages).toHaveLength(3);
    expect(r.seconds).toEqual({ culling_profile: 1, score_forecast: 1 });
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed', culling_profile_verdict: 'passed' });
    const producedBy = db
      .prepare('SELECT v.stage_key, a.produced_by FROM cull_stage_answers a JOIN cull_stage_versions v ON v.id = a.stage_version_id ORDER BY v.id')
      .all();
    expect(producedBy).toEqual([
      { stage_key: S7, produced_by: 'this_app' },
      { stage_key: S10, produced_by: 'this_app' },
      { stage_key: 'score_forecast', produced_by: 'http://elsewhere:9000' },
    ]);
  });

  it('asks only the stages that are on', async () => {
    const noForecast = fakeLaya([5, 5, 6, 6]);
    await cullPhoto(db, context(forecastOff), noForecast, { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(noForecast.calls).toEqual([[S7, S10]]);
    const noProfiles = fakeLaya([5, 5, 6, 6]);
    await cullPhoto(db, context(profilesOff), noProfiles, { imageKey: 'b', sentByHand: false, runId, resolveImage: image });
    expect(noProfiles.calls).toEqual([['score_forecast']]);
    expect(getCullVerdict(db, 'b')).toMatchObject({ verdict: 'passed', culling_profile_verdict: null });
  });

  it("stores what the culling profile says when its filter is off: reject follows it, the photo passes", async () => {
    const ctx = context((cfg) => ({ ...cfg, culling_profiles_filter_enabled: false }));
    await cullPhoto(db, ctx, fakeLaya([5, 5, 2, 3]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed', filtered_by: null, culling_profile_verdict: 'filtered' });
  });

  it('re-decides without a model call when nothing is missing', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    const laya = fakeLaya([5, 5, 6, 6]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: true, runId, resolveImage: image });
    expect(r.outcome).toBe('redecided');
    expect(laya.calls).toEqual([]);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed', sent_by_hand: true });
  });

  it('forced, asks the models again though every stage is answered, and stores the new answers', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed' });
    const laya = fakeLaya([5, 5, 2, 3]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: false, runId, force: true, resolveImage: image });
    expect(r.outcome).toBe('culled');
    expect(laya.calls).toHaveLength(1);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'filtered', filtered_by: 'culling_profile' });
  });

  it('forced with no image: decided from what is stored', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    const r = await cullPhoto(db, ctx, fakeLaya([5, 5, 2, 3]), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      force: true,
      resolveImage: noImage,
    });
    expect(r.outcome).toBe('no_image');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'passed' });
  });

  it('no image: pending', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5]), { imageKey: 'a', sentByHand: false, runId, resolveImage: noImage });
    expect(r.outcome).toBe('no_image');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'no_image' });
  });

  it('a model fails on the photo: pending, naming the stage, and the job goes on', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'answer' }), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      resolveImage: image,
    });
    expect(r.outcome).toBe('model_failed');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'model_failed: Culling profile: boom' });
  });

  it('the image cannot be read: pending, the job goes on', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'read' }), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      resolveImage: image,
    });
    expect(r.outcome).toBe('model_failed');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'model_failed: ENOENT: no such file' });
  });

  it("a stage's endpoint stops answering on the photo: pending as such, and the error is handed back", async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'down' }), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      resolveImage: image,
    });
    expect(r.outcome).toBe('endpoint_down');
    expect(r.error?.message).toBe('Culling profile: boom');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'endpoint_down' });
  });

  it('a stage that cannot start is thrown: the job stops', async () => {
    await expect(
      cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'setup' }), { imageKey: 'a', sentByHand: false, runId, resolveImage: image }),
    ).rejects.toBeInstanceOf(CullingStageError);
  });
});

describe('selectPhotosToCull', () => {
  it('skips photos whose required stages are answered and whose summary is current', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'done', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, ctx, ['new', 'done']).keys).toEqual(['new']);
  });

  it('a stage that is off is not asked for; turned on, every photo needs it', async () => {
    const off = context(forecastOff);
    await cullPhoto(db, off, fakeLaya([5, 5, 2, 3]), { imageKey: 'filtered', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, off, ['filtered']).keys).toEqual([]);
    const on = context((cfg) => ({ ...cfg, score_forecast: { ...cfg.score_forecast, enabled: true } }));
    expect([...selectPhotosToCull(db, on, ['filtered']).needsAnswers]).toEqual(['filtered']);
  });

  it('a summary decided under another pipeline setting is selected, to be re-decided', async () => {
    await cullPhoto(db, context(), fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, context((c) => c), ['a']).keys).toEqual(['a']);
  });

  it("puts a sent-by-hand photo a stage's endpoint stopped on last too", async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 5, 5], { fail: 'down' }), { imageKey: 'died', sentByHand: true, runId, resolveImage: image });
    expect(getCullVerdict(db, 'died')).toMatchObject({ verdict: 'passed', pending_reason: 'endpoint_down' });
    expect(selectPhotosToCull(db, ctx, ['died', 'b']).keys).toEqual(['b', 'died']);
  });

  it("puts photos a stage's endpoint stopped on last", async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 5, 5], { fail: 'down' }), { imageKey: 'died', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, ctx, ['died', 'b', 'c']).keys).toEqual(['b', 'c', 'died']);
  });

  it('puts photos culled before System One, when the Laya worker died on them, last as well', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 5, 5]), { imageKey: 'old', sentByHand: false, runId, resolveImage: noImage });
    db.prepare("UPDATE cull_verdicts SET pending_reason = 'laya_worker_died' WHERE image_key = 'old'").run();
    expect(selectPhotosToCull(db, ctx, ['old', 'b']).keys).toEqual(['b', 'old']);
  });

  it('forced, takes photos already decided, all of them for the models', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'done', sentByHand: false, runId, resolveImage: image });
    const r = selectPhotosToCull(db, ctx, ['new', 'done'], { force: { doneByRuns: new Set() } });
    expect(r.keys).toEqual(['new', 'done']);
    expect([...r.needsAnswers]).toEqual(['new', 'done']);
  });

  it('forced, skips what the same job decided already but takes again what it left pending', async () => {
    const ctx = context();
    const earlier = insertCullRun(db, { kind: 'job', jobId: 'j', pipelineSettingVersion: 1 });
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'redone', sentByHand: false, runId: earlier, resolveImage: image });
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'nofile', sentByHand: false, runId: earlier, resolveImage: noImage });
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'older', sentByHand: false, runId, resolveImage: image });
    const r = selectPhotosToCull(db, ctx, ['redone', 'nofile', 'older'], { force: { doneByRuns: new Set([earlier]) } });
    expect(r.keys).toEqual(['nofile', 'older']);
  });
});
