/**
 * Library schema 15 (#368): Score forecast questions stored and versioned. A library that has answered
 * the Score forecast gets the questions it was asked (questions.json "new"), so its stage version does
 * not change and no answer becomes stale; any other library starts with none.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibraryDb, type Db } from '../src/db/connection.js';
import { initLibraryDb, LIBRARY_SCHEMA_VERSION } from '../src/db/library/bootstrap.js';
import { getOrCreateStageVersion } from '../src/db/library/cull-stages.js';
import { getForecastQuestions, saveForecastQuestions } from '../src/db/library/score-forecast-questions.js';
import { resolveCurrentStages, SCORE_FORECAST_STAGE_KEY } from '../src/cull/stages.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';

const MODEL = 'laya-new@sha256:abc';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-v15-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A v14 library, optionally one that has answered the Score forecast. Returns that stage version's id. */
function writeV14Library(path: string, answered: boolean): number | null {
  const db = initLibraryDb(path);
  let id: number | null = null;
  if (answered) {
    id = getOrCreateStageVersion(db, {
      stageKey: SCORE_FORECAST_STAGE_KEY,
      kind: 'score_forecast',
      profileSlug: null,
      levelSet: null,
      modelId: MODEL,
      questions: LAYA_QUESTIONS.new,
    });
  }
  db.exec('DROP TABLE score_forecast_question_versions');
  db.pragma('user_version = 14');
  db.close();
  return id;
}

const forecastStage = (db: Db) =>
  resolveCurrentStages(db, getCurrentPipelineSetting(db).config, { culling_profile: null, score_forecast: MODEL }).find(
    (s) => s.kind === 'score_forecast',
  );

describe('library schema 15', () => {
  it('a library that answered the Score forecast keeps its stage version', () => {
    const path = join(dir, 'library.db');
    const before = writeV14Library(path, true);
    const db = initLibraryDb(path);
    try {
      expect(LIBRARY_SCHEMA_VERSION).toBe(15);
      expect(db.pragma('user_version', { simple: true })).toBe(15);
      const set = getForecastQuestions(db);
      expect(set.version).toBe(1);
      expect(set.questions.map((q) => [q.id, q.perspective_slug, q.optional])).toEqual([
        ['framing', 'framing', true],
        ['compositional-cleanliness', 'compositional-cleanliness', false],
        ['environmental-context-legibility', 'environmental-context-legibility', false],
        ['intensity-suggestion', 'intensity-suggestion', false],
      ]);
      expect(set.questions[0]!.name).toBe('Framing');
      expect(forecastStage(db)?.versionId).toBe(before);
    } finally {
      db.close();
    }
  });

  it('a library that never answered it starts with no questions, and so does a new one', () => {
    writeV14Library(join(dir, 'old.db'), false);
    for (const name of ['old.db', 'new.db']) {
      const db = initLibraryDb(join(dir, name));
      try {
        expect(getForecastQuestions(db)).toEqual({ questions: [], version: 0, versionId: null });
        expect(forecastStage(db)).toBeUndefined();
      } finally {
        db.close();
      }
    }
  });

  it('upgrading twice changes nothing', () => {
    const path = join(dir, 'library.db');
    writeV14Library(path, true);
    initLibraryDb(path).close();
    const raw = openLibraryDb(path);
    raw.pragma('user_version = 14');
    raw.close();
    const db = initLibraryDb(path);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM score_forecast_question_versions').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('editing Score forecast questions', () => {
  it('a text change makes a new stage version; going back to the old text reuses its version and answers', () => {
    const path = join(dir, 'library.db');
    const original = writeV14Library(path, true);
    const db = initLibraryDb(path);
    try {
      const questions = getForecastQuestions(db).questions;
      const edited = questions.map((q) => (q.id === 'framing' ? { ...q, instructions: `${q.instructions} Be strict.` } : q));

      expect(saveForecastQuestions(db, edited)).toMatchObject({ version: 2, created: true });
      const editedVersion = forecastStage(db)!.versionId;
      expect(editedVersion).not.toBe(original);

      expect(saveForecastQuestions(db, questions)).toMatchObject({ version: 1, created: false });
      expect(getForecastQuestions(db).version).toBe(1);
      expect(forecastStage(db)!.versionId).toBe(original);
    } finally {
      db.close();
    }
  });

  it('a name or perspective change is a new version of the questions but not of the stage', () => {
    const path = join(dir, 'library.db');
    const original = writeV14Library(path, true);
    const db = initLibraryDb(path);
    try {
      const renamed = getForecastQuestions(db).questions.map((q) => ({ ...q, name: `${q.name}!`, perspective_slug: null }));
      expect(saveForecastQuestions(db, renamed)).toMatchObject({ version: 2, created: true });
      expect(forecastStage(db)!.versionId).toBe(original);
    } finally {
      db.close();
    }
  });

  it('saving the same questions makes no version', () => {
    const db = initLibraryDb(join(dir, 'library.db'));
    try {
      expect(saveForecastQuestions(db, [])).toEqual({ version: 0, created: false });
    } finally {
      db.close();
    }
  });
});
