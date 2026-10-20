/**
 * One photo through the cull (`cull/answer-photo.ts`) and the choice of photos to cull
 * (`cull/select.ts`), on a temp library and a fake Laya.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askNow, cullPhoto, runsAfterCut, type LayaAnswerer } from '../src/cull/answer-photo.js';
import type { CullContext } from '../src/cull/persist.js';
import { selectPhotosToCull } from '../src/cull/select.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import type { PipelineSettingConfig } from '../src/cull/types.js';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { getCullVerdict, insertCullRun } from '../src/db/library/cull-verdicts.js';
import type { LayaAnswerWant } from '../src/laya/sessions.js';

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
const MODEL_IDS = { base: 'base@1', new: 'new@1' };

let dir: string;
let db: Db;
let runId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-photo-'));
  db = initLibraryDb(join(dir, 'library.db'));
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

const forecastOffForCut = (cfg: PipelineSettingConfig): PipelineSettingConfig => ({
  ...cfg,
  score_forecast: { ...cfg.score_forecast, run_after_cut: false },
});

/** A fake Laya: recipe levels per photo on both level sets, P(≥ 8) 0.5. */
function fakeLaya(levels10: number[], opts: { fail?: 'answer' | 'worker' } = {}) {
  const calls: LayaAnswerWant[] = [];
  const at = (l: number, n: number) => Array.from({ length: n }, (_, i) => (i === l - 1 ? 1 : 0));
  const laya: LayaAnswerer & { calls: LayaAnswerWant[]; broken: boolean } = {
    calls,
    broken: false,
    async answer(_file, want = {}) {
      calls.push(want);
      if (opts.fail) {
        if (opts.fail === 'worker') laya.broken = true;
        throw new Error('boom');
      }
      const base: Record<string, number[]> = {};
      for (const q of want.base ?? []) {
        const [set, dim] = q.split('#')[1]!.split('|');
        const l = levels10[DIMS.indexOf(dim!)]!;
        base[q] = set === '7' ? at(Math.round(1 + ((l - 1) * 6) / 9), 7) : at(l, 10);
      }
      const neu = want.new ? { 'framing-excusal': [1, 0], 'intensity-suggestion': [0.5, 0, 0, 0, 0, 0, 0, 0.5, 0, 0] } : null;
      return { answers: { base, new: neu }, seconds: { prep: 1, vision: 1, base: 1, new: 1, total: 4 } };
    },
  };
  return laya;
}

const image = async () => '/cache/a.jpg';
const noImage = async () => null;

describe('which stages to ask now', () => {
  it('asks everything at once when every stage runs after a cut', () => {
    const ctx = context();
    expect(askNow(ctx.pipeline.config, ctx.stages).map((s) => s.stageKey)).toEqual(ctx.stages.map((s) => s.stageKey));
  });

  it('holds back a stage switched off for cut photos until the stages before it are answered', () => {
    const ctx = context(forecastOffForCut);
    const forecast = ctx.stages.find((s) => s.kind === 'score_forecast')!;
    expect(runsAfterCut(ctx.pipeline.config, forecast)).toBe(false);
    expect(askNow(ctx.pipeline.config, ctx.stages).map((s) => s.kind)).toEqual(['culling_recipe', 'culling_recipe']);
    expect(askNow(ctx.pipeline.config, [forecast])).toEqual([forecast]);
  });
});

describe('cullPhoto', () => {
  it('answers what is missing in as few calls as the switches allow, and stores it', async () => {
    const ctx = context(forecastOffForCut);
    const laya = fakeLaya([5, 5, 6, 6]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(r.outcome).toBe('culled');
    expect(laya.calls.map((w) => [w.base!.length, w.new])).toEqual([
      [8, false],
      [0, true],
    ]);
    expect(r.answeredStages).toHaveLength(3);
    expect(r.seconds).toEqual({ prep: 2, vision: 2, base: 2, new: 2 });
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'sent' });
  });

  it('re-decides without Laya when nothing is missing', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    const laya = fakeLaya([5, 5, 6, 6]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: true, runId, resolveImage: image });
    expect(r.outcome).toBe('redecided');
    expect(laya.calls).toEqual([]);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'sent', sent_by_hand: true });
  });

  it('forced, asks Laya again though every stage is answered, and stores the new answers', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'sent' });
    const laya = fakeLaya([5, 5, 2, 3]);
    const r = await cullPhoto(db, ctx, laya, { imageKey: 'a', sentByHand: false, runId, force: true, resolveImage: image });
    expect(r.outcome).toBe('culled');
    expect(laya.calls).toHaveLength(1);
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'cut', cut_by: 'culling_recipe' });
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
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'sent' });
  });

  it('no image: pending', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5]), { imageKey: 'a', sentByHand: false, runId, resolveImage: noImage });
    expect(r.outcome).toBe('no_image');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'no_image' });
  });

  it('Laya fails on the photo: pending, the job goes on', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'answer' }), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      resolveImage: image,
    });
    expect(r.outcome).toBe('laya_failed');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'laya_failed: boom' });
  });

  it('the worker dies on the photo: pending as such, and the error is handed back', async () => {
    const r = await cullPhoto(db, context(), fakeLaya([5, 5, 5, 5], { fail: 'worker' }), {
      imageKey: 'a',
      sentByHand: false,
      runId,
      resolveImage: image,
    });
    expect(r.outcome).toBe('worker_died');
    expect(r.error?.message).toBe('boom');
    expect(getCullVerdict(db, 'a')).toMatchObject({ verdict: 'pending', pending_reason: 'laya_worker_died' });
  });
});

describe('selectPhotosToCull', () => {
  it('skips photos whose required stages are answered and whose summary is current', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 6, 6]), { imageKey: 'done', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, ctx, ['new', 'done']).keys).toEqual(['new']);
  });

  it('a photo the recipe cut is not selected again for a stage switched off for cut photos', async () => {
    const ctx = context(forecastOffForCut);
    await cullPhoto(db, ctx, fakeLaya([5, 5, 2, 3]), { imageKey: 'cut', sentByHand: false, runId, resolveImage: image });
    expect(getCullVerdict(db, 'cut')).toMatchObject({ verdict: 'cut' });
    expect(selectPhotosToCull(db, ctx, ['cut']).keys).toEqual([]);
  });

  it('a summary decided under another pipeline setting is selected, to be re-decided', async () => {
    await cullPhoto(db, context(), fakeLaya([5, 5, 6, 6]), { imageKey: 'a', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, context((c) => c), ['a']).keys).toEqual(['a']);
  });

  it('puts a sent-by-hand photo the worker died on last too', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 5, 5], { fail: 'worker' }), { imageKey: 'died', sentByHand: true, runId, resolveImage: image });
    expect(getCullVerdict(db, 'died')).toMatchObject({ verdict: 'sent', pending_reason: 'laya_worker_died' });
    expect(selectPhotosToCull(db, ctx, ['died', 'b']).keys).toEqual(['b', 'died']);
  });

  it('puts photos the worker died on last', async () => {
    const ctx = context();
    await cullPhoto(db, ctx, fakeLaya([5, 5, 5, 5], { fail: 'worker' }), { imageKey: 'died', sentByHand: false, runId, resolveImage: image });
    expect(selectPhotosToCull(db, ctx, ['died', 'b', 'c']).keys).toEqual(['b', 'c', 'died']);
  });

  it('forced, takes photos already decided, all of them for Laya', async () => {
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
