import { levelSetReadout } from '../cull/decide.js';
import type { RecipeDefinition, RecipeRule, StageAnswers } from '../cull/types.js';
import type { StarsStrongFrom } from './writeback-types.js';

export type { StarsStrongFrom };

export function starsStrongFrom(rule: RecipeRule): StarsStrongFrom {
  return rule.stars_strong_from ?? 'every';
}

export function ratingFromStrongCount(count: number): number | null {
  if (count <= 0) return null;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}

function dimensionStrongAtLevelSet(
  answers: StageAnswers,
  bands: { fails_at_most: number; strong_at_least: number },
  dim: string,
  levelSet: string,
): boolean {
  const qid = `${levelSet}|${dim}`;
  const probs = answers[qid];
  if (!probs?.length) return false;
  const readout = levelSetReadout({ [qid]: probs }, bands);
  return readout[qid]?.strong === true;
}

/**
 * Count dimensions that qualify as "strong" for stars, using the recipe rule's
 * `stars_strong_from` mode and stored stage answers keyed by stage key.
 */
export function countStrongDimensions(
  definition: RecipeDefinition,
  rule: RecipeRule,
  answersByStageKey: Record<string, StageAnswers>,
  recipeSlug: string,
): number {
  const mode = starsStrongFrom(rule);
  const levelSetIds = Object.keys(rule.level_sets);
  let strongDims = 0;
  for (const dim of definition.dimensions) {
    const slug = dim.slug;
    let strong = false;
    if (mode === '7' || mode === '10') {
      const bands = rule.level_sets[mode];
      if (!bands) continue;
      const stageKey = `culling_recipe:${recipeSlug}:${mode}`;
      strong = dimensionStrongAtLevelSet(answersByStageKey[stageKey] ?? {}, bands, slug, mode);
    } else if (mode === 'every') {
      strong = levelSetIds.every((ls) => {
        const bands = rule.level_sets[ls];
        if (!bands) return false;
        const stageKey = `culling_recipe:${recipeSlug}:${ls}`;
        return dimensionStrongAtLevelSet(answersByStageKey[stageKey] ?? {}, bands, slug, ls);
      });
    } else {
      strong = levelSetIds.some((ls) => {
        const bands = rule.level_sets[ls];
        if (!bands) return false;
        const stageKey = `culling_recipe:${recipeSlug}:${ls}`;
        return dimensionStrongAtLevelSet(answersByStageKey[stageKey] ?? {}, bands, slug, ls);
      });
    }
    if (strong) strongDims += 1;
  }
  return strongDims;
}
