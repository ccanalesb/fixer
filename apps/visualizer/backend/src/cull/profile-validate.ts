/**
 * Reject culling profile text that would not fit in a row of the culling profile stage's model. Only a
 * model in this app has a known budget; with another endpoint, or no model yet, only the shape is checked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadLibraryConfig } from '../config.js';
import { buildRow, type ModelMeta } from '../app-models/rows.js';
import type { SystemOneQuestion } from '../systemone/question.js';
import { THIS_APP_ENDPOINT } from '../systemone/client.js';
import type { ProfileDefinition } from './types.js';

export interface ProfileValidationError {
  field: string;
  message: string;
}

export interface ProfileValidationResult {
  ok: boolean;
  errors: ProfileValidationError[];
}

function questionsForDefinition(definition: ProfileDefinition): Record<string, SystemOneQuestion> {
  const out: Record<string, SystemOneQuestion> = {};
  for (const set of definition.level_sets) {
    for (const dim of definition.dimensions) {
      const criteria = set.levels[dim.slug];
      if (!criteria?.length) {
        throw new Error(`level set ${set.id} missing levels for ${dim.slug}`);
      }
      out[`${set.id}|${dim.slug}`] = {
        type: 'score',
        instructions: dim.question,
        criteria,
      };
    }
  }
  return out;
}

/** The culling profile stage's model when it is installed in this app; null otherwise. */
function stageModelDir(): string | null {
  const cfg = loadLibraryConfig(config.LT_CONFIG_YAML);
  const stage = cfg.cullingModels.culling_profile;
  if (stage.endpoint !== THIS_APP_ENDPOINT || !stage.model) return null;
  const dir = join(cfg.appModelsDir, stage.model);
  return existsSync(join(dir, 'model.json')) ? dir : null;
}

function loadMetaAndEncode(dir: string): { meta: ModelMeta; encode: (s: string) => number[] } {
  const meta = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')) as ModelMeta;
  const tokJson = JSON.parse(readFileSync(join(dir, 'tokenizer', 'tokenizer.json'), 'utf8')) as {
    model?: { vocab?: Record<string, number> };
  };
  const vocab = tokJson.model?.vocab ?? {};
  const encode = (s: string): number[] => {
    const ids: number[] = [];
    for (const ch of s) {
      const id = vocab[ch];
      ids.push(typeof id === 'number' ? id : 1);
    }
    return ids.length > 0 ? ids : [1];
  };
  return { meta, encode };
}

/** Validate every question/level set row against the culling profile stage model's budget, when known. */
export function validateProfileDefinition(definition: ProfileDefinition): ProfileValidationResult {
  let questions: Record<string, SystemOneQuestion>;
  try {
    questions = questionsForDefinition(definition);
  } catch (e) {
    return { ok: false, errors: [{ field: 'definition', message: e instanceof Error ? e.message : String(e) }] };
  }
  const dir = stageModelDir();
  if (!dir) return { ok: true, errors: [] };
  let model: ReturnType<typeof loadMetaAndEncode>;
  try {
    model = loadMetaAndEncode(dir);
  } catch (e) {
    return { ok: false, errors: [{ field: 'model', message: e instanceof Error ? e.message : String(e) }] };
  }
  const errors: ProfileValidationError[] = [];
  for (const [qid, q] of Object.entries(questions)) {
    try {
      buildRow(model.encode, model.meta, qid, q);
    } catch (err) {
      errors.push({ field: qid, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: errors.length === 0, errors };
}
