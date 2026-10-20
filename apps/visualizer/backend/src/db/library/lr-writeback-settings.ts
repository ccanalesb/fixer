import { getCurrentPipelineSetting } from './cull-pipeline.js';
import { getCullRecipe } from './cull-recipes.js';
import type { Db } from '../connection.js';
import { libraryWrite } from './write.js';

export interface LrWritebackSettings {
  write_stars: boolean;
  write_reject: boolean;
  stars_recipe_slug: string | null;
}

export function getLrWritebackSettings(db: Db): LrWritebackSettings {
  const row = db
    .prepare('SELECT write_stars, write_reject, stars_recipe_slug FROM lr_writeback_settings WHERE id = 1')
    .get() as { write_stars: number; write_reject: number; stars_recipe_slug: string | null } | undefined;
  if (!row) {
    return { write_stars: false, write_reject: false, stars_recipe_slug: null };
  }
  return {
    write_stars: row.write_stars === 1,
    write_reject: row.write_reject === 1,
    stars_recipe_slug: row.stars_recipe_slug,
  };
}

export function activePipelineRecipeSlugs(db: Db): string[] {
  const pipe = getCurrentPipelineSetting(db);
  return pipe.config.culling_recipes.map((r) => r.recipe_slug);
}

export function activePipelineRecipes(db: Db): { slug: string; name: string }[] {
  return activePipelineRecipeSlugs(db).map((slug) => {
    const recipe = getCullRecipe(db, slug);
    return { slug, name: recipe?.name ?? slug };
  });
}

/** Slug used for star computation; null when stars are off or pipeline has no recipes. */
export function resolveStarsRecipeSlug(db: Db, settings: LrWritebackSettings): string | null {
  const active = activePipelineRecipeSlugs(db);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!;
  return settings.stars_recipe_slug;
}

export interface PatchLrWritebackSettings {
  write_stars?: boolean;
  write_reject?: boolean;
  stars_recipe_slug?: string | null;
}

export function patchLrWritebackSettings(db: Db, patch: PatchLrWritebackSettings): LrWritebackSettings {
  return libraryWrite(db, () => {
    const cur = getLrWritebackSettings(db);
    const next: LrWritebackSettings = {
      write_stars: patch.write_stars ?? cur.write_stars,
      write_reject: patch.write_reject ?? cur.write_reject,
      stars_recipe_slug: patch.stars_recipe_slug !== undefined ? patch.stars_recipe_slug : cur.stars_recipe_slug,
    };
    db.prepare(
      `UPDATE lr_writeback_settings SET write_stars = ?, write_reject = ?, stars_recipe_slug = ? WHERE id = 1`,
    ).run(next.write_stars ? 1 : 0, next.write_reject ? 1 : 0, next.stars_recipe_slug);
    return next;
  });
}
