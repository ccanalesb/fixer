/**
 * Score forecast questions, stored and versioned like a culling profile's text (#368): one set, a new
 * version when anything in it changes, and text a past version already had makes that version current
 * again. What the model is asked comes from the current version (`cull/forecast-questions.ts`), so the
 * stage version follows the text and going back reuses the answers stored under it.
 */
import { createHash } from 'node:crypto';
import { questionsFromLaya, type ScoreForecastQuestion } from '../../cull/forecast-questions.js';
import { LAYA_QUESTIONS } from '../../laya/questions.js';
import { canonicalJson } from '../../utils/canonical-json.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { libraryWrite } from './write.js';

export const SCORE_FORECAST_QUESTIONS_SQL = `
CREATE TABLE IF NOT EXISTS score_forecast_question_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    -- {"questions": [...]}: cull/forecast-questions.ts ScoreForecastQuestion.
    definition_json TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_score_forecast_question_versions_current
    ON score_forecast_question_versions(is_current) WHERE is_current = 1;
`;

export interface ForecastQuestionSet {
  questions: ScoreForecastQuestion[];
  /** 0 before any is saved. */
  version: number;
  versionId: number | null;
}

const hashOf = (questions: readonly ScoreForecastQuestion[]): string =>
  createHash('sha256').update(canonicalJson({ questions })).digest('hex');

export function getForecastQuestions(db: Db): ForecastQuestionSet {
  const row = db
    .prepare('SELECT id, version, definition_json FROM score_forecast_question_versions WHERE is_current = 1')
    .get() as { id: number; version: number; definition_json: string } | undefined;
  if (!row) return { questions: [], version: 0, versionId: null };
  const { questions } = JSON.parse(row.definition_json) as { questions: ScoreForecastQuestion[] };
  return { questions, version: row.version, versionId: row.id };
}

/** Save the set. A new version only when it changed; a past version's text makes that version current. */
export function saveForecastQuestions(
  db: Db,
  questions: readonly ScoreForecastQuestion[],
): { version: number; created: boolean } {
  return libraryWrite(db, () => {
    const current = getForecastQuestions(db);
    const hash = hashOf(questions);
    if (hash === hashOf(current.questions)) return { version: current.version, created: false };
    db.prepare('UPDATE score_forecast_question_versions SET is_current = 0').run();
    const past = db.prepare('SELECT id, version FROM score_forecast_question_versions WHERE content_hash = ?').get(hash) as
      | { id: number; version: number }
      | undefined;
    if (past) {
      db.prepare('UPDATE score_forecast_question_versions SET is_current = 1 WHERE id = ?').run(past.id);
      return { version: past.version, created: false };
    }
    const { next } = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM score_forecast_question_versions')
      .get() as { next: number };
    db.prepare(
      `INSERT INTO score_forecast_question_versions (version, definition_json, content_hash, is_current, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(next, JSON.stringify({ questions }), hash, nowIsoUtc());
    return { version: next, created: true };
  });
}

/** Display names by slug, for tying questions.json's rows to this library's perspectives. */
function perspectiveNames(db: Db): Record<string, string> {
  const rows = db.prepare('SELECT slug, display_name FROM perspectives').all() as { slug: string; display_name: string }[];
  return Object.fromEntries(rows.map((r) => [r.slug, r.display_name]));
}

/** The questions Laya new was trained on (`questions.json` "new"), tied to this library's perspectives. */
export function layaNewForecastQuestions(db: Db): ScoreForecastQuestion[] {
  return questionsFromLaya(LAYA_QUESTIONS.new, perspectiveNames(db));
}

/**
 * Laya new's questions stored as version 1, for a library that has answered the Score forecast: it was
 * asked exactly those. Returns whether it stored them.
 */
export function prepopulateForecastQuestions(db: Db): boolean {
  if (db.prepare('SELECT 1 FROM score_forecast_question_versions LIMIT 1').get()) return false;
  const answered = db.prepare("SELECT 1 FROM cull_stage_versions WHERE kind = 'score_forecast' LIMIT 1").get();
  if (!answered) return false;
  saveForecastQuestions(db, layaNewForecastQuestions(db));
  return true;
}
