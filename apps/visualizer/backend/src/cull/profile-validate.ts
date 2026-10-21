/**
 * Reject culling profile text that would not fit in a Laya row at runtime.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, loadLibraryConfig } from '../config.js';
import { buildRow, type LayaModelMeta, type LayaQuestion } from '../laya/rows.js';
import type { ProfileDefinition } from './types.js';

export interface ProfileValidationError {
  field: string;
  message: string;
}

export interface ProfileValidationResult {
  ok: boolean;
  errors: ProfileValidationError[];
}

function questionsForDefinition(definition: ProfileDefinition): Record<string, LayaQuestion> {
  const out: Record<string, LayaQuestion> = {};
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

function loadBaseMetaAndEncode(modelSlug: string): { meta: LayaModelMeta; encode: (s: string) => number[] } {
  const modelsRoot = loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir;
  const dir = join(modelsRoot, modelSlug === 'laya-base' ? 'laya-base' : modelSlug);
  const meta = JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')) as LayaModelMeta;
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

/** Validate every question/level set row against the profile model's Laya budget. */
export function validateProfileDefinitionForLaya(
  definition: ProfileDefinition,
  modelSlug: string,
): ProfileValidationResult {
  const errors: ProfileValidationError[] = [];
  let meta: LayaModelMeta;
  let encode: (s: string) => number[];
  try {
    ({ meta, encode } = loadBaseMetaAndEncode(modelSlug));
  } catch (e) {
    return {
      ok: false,
      errors: [{ field: 'model', message: e instanceof Error ? e.message : String(e) }],
    };
  }
  try {
    const questions = questionsForDefinition(definition);
    for (const [qid, q] of Object.entries(questions)) {
      try {
        buildRow(encode, meta, qid, q);
      } catch (err) {
        errors.push({
          field: qid,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (e) {
    errors.push({ field: 'definition', message: e instanceof Error ? e.message : String(e) });
  }
  return { ok: errors.length === 0, errors };
}
