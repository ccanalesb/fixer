/**
 * Score forecast questions, stored and versioned: the stage version follows what Laya is asked, so
 * going back to an old text reuses the answers stored under it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/connection.js';
import { initLibraryDb } from '../src/db/library/bootstrap.js';
import {
  getForecastQuestions,
  layaNewForecastQuestions,
  saveForecastQuestions,
} from '../src/db/library/score-forecast-questions.js';
import { resolveCurrentStages } from '../src/cull/stages.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

const MODEL = 'laya-new@sha256:abc';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-forecast-q-'));
  db = initLibraryDb(join(dir, 'library.db'));
  seedCullingStagesOn(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const forecastStage = () =>
  resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { culling_profile: null, score_forecast: MODEL }).find(
    (s) => s.kind === 'score_forecast',
  );

/** Laya new's questions saved as version 1; returns their stage version's id. */
function saveLayaNewQuestions(): number {
  saveForecastQuestions(db, layaNewForecastQuestions(db));
  return forecastStage()!.versionId;
}

describe('editing Score forecast questions', () => {
  it('a new library starts with none, and no Score forecast stage', () => {
    expect(getForecastQuestions(db)).toEqual({ questions: [], version: 0, versionId: null });
    expect(forecastStage()).toBeUndefined();
  });

  it('a text change makes a new stage version; going back to the old text reuses its version and answers', () => {
    const original = saveLayaNewQuestions();
    const questions = getForecastQuestions(db).questions;
    const edited = questions.map((q) => (q.id === 'framing' ? { ...q, instructions: `${q.instructions} Be strict.` } : q));

    expect(saveForecastQuestions(db, edited)).toMatchObject({ version: 2, created: true });
    expect(forecastStage()!.versionId).not.toBe(original);

    expect(saveForecastQuestions(db, questions)).toMatchObject({ version: 1, created: false });
    expect(getForecastQuestions(db).version).toBe(1);
    expect(forecastStage()!.versionId).toBe(original);
  });

  it('a name or perspective change is a new version of the questions but not of the stage', () => {
    const original = saveLayaNewQuestions();
    const renamed = getForecastQuestions(db).questions.map((q) => ({ ...q, name: `${q.name}!`, perspective_slug: null }));
    expect(saveForecastQuestions(db, renamed)).toMatchObject({ version: 2, created: true });
    expect(forecastStage()!.versionId).toBe(original);
  });

  it('saving the same questions makes no version', () => {
    expect(saveForecastQuestions(db, [])).toEqual({ version: 0, created: false });
  });
});
