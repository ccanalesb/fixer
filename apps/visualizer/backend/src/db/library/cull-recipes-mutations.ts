/**
 * Culling recipe mutations beyond the core CRUD in `cull-recipes.ts`.
 */
import { defaultPipelineSetting } from '../../cull/default-pipeline.js';
import type { RecipeDefinition, RecipeRule } from '../../cull/types.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from './cull-pipeline.js';
import {
  createCullRecipe,
  definitionHash,
  getCullRecipe,
  saveRecipeDefinition,
  setRecipeRule,
  type CullRecipe,
  type NewCullRecipe,
} from './cull-recipes.js';
import { libraryWrite } from './write.js';

export function duplicateCullRecipe(
  db: Db,
  slug: string,
  newSlug: string,
  newName?: string,
): CullRecipe {
  const src = getCullRecipe(db, slug);
  if (!src) throw new Error(`no culling recipe ${slug}`);
  if (getCullRecipe(db, newSlug)) throw new Error(`culling recipe ${newSlug} already exists`);
  return createCullRecipe(db, {
    slug: newSlug,
    name: newName ?? `${src.name} (copy)`,
    model: src.model,
    definition: structuredClone(src.definition),
    rule: structuredClone(src.rule),
    measured: false,
    active: false,
  });
}

export function updateCullRecipeMeta(
  db: Db,
  slug: string,
  patch: { name?: string; model?: string; active?: boolean },
): CullRecipe {
  return libraryWrite(db, () => {
    const recipe = getCullRecipe(db, slug);
    if (!recipe) throw new Error(`no culling recipe ${slug}`);
    const name = patch.name ?? recipe.name;
    const model = patch.model ?? recipe.model;
    const active = patch.active ?? recipe.active;
    db.prepare('UPDATE cull_recipes SET name = ?, model = ?, active = ?, updated_at = ? WHERE slug = ?').run(
      name,
      model,
      active ? 1 : 0,
      nowIsoUtc(),
      slug,
    );
    return getCullRecipe(db, slug)!;
  });
}

/** Add, remove, or reorder a recipe in the pipeline config; returns new pipeline version or null. */
export function setCullRecipePipelineActive(db: Db, slug: string, inPipeline: boolean): number | null {
  return libraryWrite(db, () => {
    const recipe = getCullRecipe(db, slug);
    if (!recipe) throw new Error(`no culling recipe ${slug}`);
    const { config } = getCurrentPipelineSetting(db);
    const exists = config.culling_recipes.some((r) => r.recipe_slug === slug);
    if (inPipeline === exists) return null;
    let next = config.culling_recipes;
    if (inPipeline) {
      next = [...next, { recipe_slug: slug, rule: recipe.rule, run_after_cut: true }];
    } else {
      next = next.filter((r) => r.recipe_slug !== slug);
    }
    return createPipelineSettingVersion(db, { ...config, culling_recipes: next }, `${slug} pipeline ${inPipeline ? 'on' : 'off'}`);
  });
}

export function saveCullRecipeRuleAndBands(db: Db, slug: string, rule: RecipeRule): number | null {
  return setRecipeRule(db, slug, rule);
}

export function countCatalogPhotosForCullEstimate(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM images i WHERE lower(i.filepath) NOT LIKE '%.mp4' AND lower(i.filepath) NOT LIKE '%.mov'",
    )
    .get() as { n: number };
  return row.n;
}

export function defaultMinimalRecipeDefinition(): RecipeDefinition {
  const dim = { slug: 'dimension-1', name: 'Dimension 1', question: '' };
  const levels = ['', '', '', '', ''];
  return {
    dimensions: [dim],
    level_sets: [{ id: '5', levels: { [dim.slug]: levels } }],
  };
}

export function defaultMinimalRecipeRule(): RecipeRule {
  return {
    level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
    combine: 'any',
    cut_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
  };
}

export { saveRecipeDefinition, definitionHash };
