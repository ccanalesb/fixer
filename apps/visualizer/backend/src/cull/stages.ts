/**
 * The pipeline setting → the stages a photo goes through, each at its current version, and what the
 * Laya worker is asked for them.
 *
 * Recipe stage question ids are `<level set>|<dimension>`, the ids slice 1 and the research used, so
 * the seeded recipe's stage versions hash the same text the research runs answered. In the worker the
 * ids are prefixed with the stage key, since two recipes may share a level set.
 */
import type { Db } from '../db/connection.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { getOrCreateStageVersion } from '../db/library/cull-stages.js';
import { libraryWrite } from '../db/library/write.js';
import type { LayaAnswers } from '../laya/sessions.js';
import { LAYA_QUESTIONS } from '../laya/questions.js';
import type { LayaQuestion } from '../laya/rows.js';
import type { PipelineSettingConfig, ResolvedStage, StageAnswers } from './types.js';

export const SCORE_FORECAST_STAGE_KEY = 'score_forecast';

/** `model.json` identity per Laya model; null `new` when Laya new is not set up. */
export interface LayaModelIds {
  base: string;
  new: string | null;
}

/** The recipe "Model" field values the cull can run. */
const RECIPE_MODELS: Record<string, 'base'> = { 'laya-base': 'base' };

export function recipeStageKey(recipeSlug: string, levelSet: string): string {
  return `culling_recipe:${recipeSlug}:${levelSet}`;
}

/**
 * Every stage of the current pipeline, at the version its text and model make, created and marked
 * current as needed. The Score forecast is left out when Laya new is not set up.
 */
export function resolveCurrentStages(db: Db, pipeline: PipelineSettingConfig, models: LayaModelIds): ResolvedStage[] {
  return libraryWrite(db, () => {
    const stages: ResolvedStage[] = [];
    for (const entry of pipeline.culling_recipes) {
      const recipe = getCullRecipe(db, entry.recipe_slug);
      if (!recipe) throw new Error(`the cull pipeline setting names a culling recipe that does not exist: ${entry.recipe_slug}`);
      const model = RECIPE_MODELS[recipe.model];
      if (!model) throw new Error(`culling recipe ${recipe.slug}: model ${recipe.model} is not one the cull can run`);
      for (const set of recipe.definition.level_sets) {
        if (!entry.rule.level_sets[set.id]) {
          throw new Error(`culling recipe ${recipe.slug}: the rule has no "fails at" / "strong at" for level set ${set.id}`);
        }
        const questions: Record<string, LayaQuestion> = {};
        for (const dim of recipe.definition.dimensions) {
          questions[`${set.id}|${dim.slug}`] = { type: 'score', instructions: dim.question, criteria: set.levels[dim.slug] };
        }
        const spec = {
          stageKey: recipeStageKey(recipe.slug, set.id),
          kind: 'culling_recipe' as const,
          recipeSlug: recipe.slug,
          levelSet: set.id,
          modelId: models.base,
          questions,
        };
        stages.push({ ...spec, model, versionId: getOrCreateStageVersion(db, spec) });
      }
    }
    if (models.new !== null) {
      const spec = {
        stageKey: SCORE_FORECAST_STAGE_KEY,
        kind: 'score_forecast' as const,
        recipeSlug: null,
        levelSet: null,
        modelId: models.new,
        questions: LAYA_QUESTIONS.new,
      };
      stages.push({ ...spec, model: 'new', versionId: getOrCreateStageVersion(db, spec) });
    }
    return stages;
  });
}

/** What the worker loads: every recipe stage's rows for Laya base, Laya new's own rows. */
export interface LayaQuestionSet {
  base: Record<string, LayaQuestion>;
  new: Record<string, LayaQuestion>;
}

/** What one worker call answers: Laya base rows by worker question id, and whether Laya new runs. */
export interface LayaWant {
  base: string[];
  new: boolean;
}

const workerQid = (stage: ResolvedStage, qid: string): string => `${stage.stageKey}#${qid}`;

export function layaQuestionSet(stages: readonly ResolvedStage[]): LayaQuestionSet {
  const base: Record<string, LayaQuestion> = {};
  for (const s of stages) {
    if (s.model !== 'base') continue;
    for (const [qid, q] of Object.entries(s.questions)) base[workerQid(s, qid)] = q;
  }
  return { base, new: LAYA_QUESTIONS.new };
}

export function layaWant(stages: readonly ResolvedStage[]): LayaWant {
  return {
    base: stages.filter((s) => s.model === 'base').flatMap((s) => Object.keys(s.questions).map((q) => workerQid(s, q))),
    new: stages.some((s) => s.model === 'new'),
  };
}

/** The worker's answers back onto stages: recipe answers by dimension, forecast answers by question id. */
export function stageAnswersFromLaya(stages: readonly ResolvedStage[], answers: LayaAnswers): Record<string, StageAnswers> {
  const out: Record<string, StageAnswers> = {};
  for (const s of stages) {
    if (s.model === 'new') {
      if (answers.new) out[s.stageKey] = answers.new;
      continue;
    }
    const byDim: StageAnswers = {};
    for (const qid of Object.keys(s.questions)) {
      const probs = answers.base[workerQid(s, qid)];
      if (!probs) break;
      byDim[qid.slice(qid.indexOf('|') + 1)] = probs;
    }
    if (Object.keys(byDim).length === Object.keys(s.questions).length) out[s.stageKey] = byDim;
  }
  return out;
}
