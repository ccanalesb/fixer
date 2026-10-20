/**
 * Recipe row readout maps Laya qids to dimension fail bands.
 */
import { describe, expect, it } from 'vitest';
import { buildRecipeRowReadout } from '../src/cull/review.js';
import type { RecipeDefinition, RecipeRule } from '../src/cull/types.js';
import type { CullRecipe } from '../src/db/library/cull-recipes.js';

const definition: RecipeDefinition = {
  dimensions: [
    { slug: 'immediate-impact', name: 'Immediate impact', question: 'Q' },
    { slug: 'connotation', name: 'Connotation', question: 'Q' },
  ],
  level_sets: [{ id: '7', levels: { 'immediate-impact': ['a', 'b', 'c', 'd', 'e', 'f', 'g'], connotation: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }],
};

const rule: RecipeRule = {
  level_sets: { '7': { fails_at_most: 2, strong_at_least: 5 } },
  combine: 'any',
  cut_rule: { type: 'all_fail', dimensions: ['immediate-impact'] },
};

const recipe = {
  slug: 'recipe-7h47',
  name: 'Recipe 7H47',
  model: 'laya-base',
  definition,
  rule,
} as CullRecipe;

describe('buildRecipeRowReadout', () => {
  it('marks fails when stored answers use levelSet|dimension qids', () => {
    const stageKey = 'culling_recipe:recipe-7h47:7';
    const answersByStage = {
      [stageKey]: {
        '7|immediate-impact': [0, 1, 0, 0, 0, 0, 0],
        '7|connotation': [0, 0, 1, 0, 0, 0, 0],
      },
    };
    const readout = buildRecipeRowReadout(recipe, definition, rule, answersByStage);
    const dim = readout.level_sets[0]!.dimensions.find((d) => d.slug === 'immediate-impact')!;
    expect(dim.levels[0]!.level).toBe(2);
    expect(dim.levels[0]!.fails).toBe(true);
  });
});
