/**
 * Culling recipes, like scoring perspectives: a seed file copied into a table once, then edited in the
 * app. The text (dimensions, questions, levels) is versioned — a change makes a new version and, for
 * each level set whose text changed, a new stage version. The rule is not: it is re-decided.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT } from '../../config.js';
import { defaultPipelineSetting, parseRecipeRule } from '../../cull/default-pipeline.js';
import type { RecipeDefinition, RecipeRule } from '../../cull/types.js';
import { canonicalJson } from '../../utils/canonical-json.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from './cull-pipeline.js';
import { libraryWrite } from './write.js';

/** Where the factory culling recipes live. */
export const CULLING_RECIPE_SEED_DIR = join(REPO_ROOT, 'prompts', 'culling-recipes');

/** The recipe the default pipeline setting runs. */
export const DEFAULT_CULLING_RECIPE_SLUG = 'recipe-7h47';

/**
 * Set once the factory recipes and pipeline setting are in. A one-time default, as for perspectives:
 * a user who deletes the seeded recipe does not get it back.
 */
export const CULL_DEFAULTS_SEEDED_META_KEY = 'cull_defaults_seeded_v1';

export interface CullRecipe {
  id: number;
  slug: string;
  name: string;
  model: string;
  active: boolean;
  measured: boolean;
  rule: RecipeRule;
  versionId: number;
  version: number;
  definition: RecipeDefinition;
}

interface SeedFile {
  slug: string;
  name: string;
  model: string;
  measured?: boolean;
  definition: RecipeDefinition;
  rule: RecipeRule;
}

interface RecipeRow {
  id: number;
  slug: string;
  name: string;
  model: string;
  active: number;
  measured: number;
  rule_json: string;
  version_id: number;
  version: number;
  definition_json: string;
}

const RECIPE_SELECT = `
  SELECT r.id, r.slug, r.name, r.model, r.active, r.measured, r.rule_json,
         v.id AS version_id, v.version, v.definition_json
  FROM cull_recipes r
  JOIN cull_recipe_versions v ON v.recipe_id = r.id AND v.is_current = 1`;

function toRecipe(row: RecipeRow): CullRecipe {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    model: row.model,
    active: row.active === 1,
    measured: row.measured === 1,
    rule: parseRecipeRule(JSON.parse(row.rule_json)),
    versionId: row.version_id,
    version: row.version,
    definition: JSON.parse(row.definition_json) as RecipeDefinition,
  };
}

export function definitionHash(definition: RecipeDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

export function listCullRecipes(db: Db): CullRecipe[] {
  return (db.prepare(`${RECIPE_SELECT} ORDER BY r.id`).all() as RecipeRow[]).map(toRecipe);
}

export function getCullRecipe(db: Db, slug: string): CullRecipe | null {
  const row = db.prepare(`${RECIPE_SELECT} WHERE r.slug = ?`).get(slug) as RecipeRow | undefined;
  return row ? toRecipe(row) : null;
}

export interface NewCullRecipe {
  slug: string;
  name: string;
  model: string;
  definition: RecipeDefinition;
  rule: RecipeRule;
  measured?: boolean;
  active?: boolean;
  sourceFilename?: string | null;
}

/** Insert a recipe at version 1. */
export function createCullRecipe(db: Db, r: NewCullRecipe): CullRecipe {
  const now = nowIsoUtc();
  libraryWrite(db, () => {
    const info = db
      .prepare(
        `INSERT INTO cull_recipes (slug, name, model, active, rule_json, measured, source_filename, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.slug,
        r.name,
        r.model,
        r.active === false ? 0 : 1,
        JSON.stringify(r.rule),
        r.measured ? 1 : 0,
        r.sourceFilename ?? null,
        now,
        now,
      );
    db.prepare(
      `INSERT INTO cull_recipe_versions (recipe_id, version, definition_json, content_hash, is_current, created_at)
       VALUES (?, 1, ?, ?, 1, ?)`,
    ).run(Number(info.lastInsertRowid), JSON.stringify(r.definition), definitionHash(r.definition), now);
  });
  return getCullRecipe(db, r.slug)!;
}

/**
 * Save a recipe's text. A new version only when the text changed; text a past version already had
 * makes that version current again, so its stored answers are current again too.
 */
export function saveRecipeDefinition(
  db: Db,
  slug: string,
  definition: RecipeDefinition,
): { versionId: number; version: number; created: boolean } {
  return libraryWrite(db, () => {
    const recipe = getCullRecipe(db, slug);
    if (!recipe) throw new Error(`no culling recipe ${slug}`);
    const hash = definitionHash(definition);
    if (hash === definitionHash(recipe.definition)) {
      return { versionId: recipe.versionId, version: recipe.version, created: false };
    }
    const now = nowIsoUtc();
    db.prepare('UPDATE cull_recipe_versions SET is_current = 0 WHERE recipe_id = ?').run(recipe.id);
    const past = db
      .prepare('SELECT id, version FROM cull_recipe_versions WHERE recipe_id = ? AND content_hash = ?')
      .get(recipe.id, hash) as { id: number; version: number } | undefined;
    db.prepare('UPDATE cull_recipes SET updated_at = ? WHERE id = ?').run(now, recipe.id);
    if (past) {
      db.prepare('UPDATE cull_recipe_versions SET is_current = 1 WHERE id = ?').run(past.id);
      return { versionId: past.id, version: past.version, created: false };
    }
    const { next } = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM cull_recipe_versions WHERE recipe_id = ?')
      .get(recipe.id) as { next: number };
    const info = db
      .prepare(
        `INSERT INTO cull_recipe_versions (recipe_id, version, definition_json, content_hash, is_current, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(recipe.id, next, JSON.stringify(definition), hash, now);
    return { versionId: Number(info.lastInsertRowid), version: next, created: true };
  });
}

/**
 * Change a recipe's rule. When the current pipeline setting runs the recipe, its snapshot is updated
 * in a new pipeline-setting version: the change is re-decided from stored answers, no model call.
 * Returns the new pipeline-setting version, or null when the recipe is not in the pipeline.
 */
export function setRecipeRule(db: Db, slug: string, rule: RecipeRule): number | null {
  parseRecipeRule(rule);
  return libraryWrite(db, () => {
    const info = db
      .prepare('UPDATE cull_recipes SET rule_json = ?, updated_at = ? WHERE slug = ?')
      .run(JSON.stringify(rule), nowIsoUtc(), slug);
    if (info.changes === 0) throw new Error(`no culling recipe ${slug}`);
    const { config } = getCurrentPipelineSetting(db);
    if (!config.culling_recipes.some((r) => r.recipe_slug === slug)) return null;
    return createPipelineSettingVersion(
      db,
      {
        ...config,
        culling_recipes: config.culling_recipes.map((r) => (r.recipe_slug === slug ? { ...r, rule } : r)),
      },
      `rule of ${slug} changed`,
    );
  });
}

function readSeedFiles(dir: string): { file: string; seed: SeedFile }[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => extname(n).toLowerCase() === '.json')
    .map((file) => ({ file, seed: JSON.parse(readFileSync(join(dir, file), 'utf8')) as SeedFile }));
}

/**
 * Copy the factory recipes into the table and write pipeline-setting version 1, once per library.
 * Returns whether it seeded. Runs from the version-11 upgrade and `initLibraryDb`; the cull job and
 * the research import call it too, for databases made with the bare schema.
 */
export function seedCullingDefaults(db: Db, dir: string = CULLING_RECIPE_SEED_DIR): boolean {
  const seeded = db.prepare('SELECT 1 FROM library_meta WHERE key = ?').get(CULL_DEFAULTS_SEEDED_META_KEY);
  if (seeded) return false;
  return libraryWrite(db, () => {
    for (const { file, seed } of readSeedFiles(dir)) {
      if (getCullRecipe(db, seed.slug)) continue;
      createCullRecipe(db, { ...seed, measured: seed.measured ?? false, sourceFilename: file });
    }
    const hasPipeline = db.prepare('SELECT 1 FROM cull_pipeline_settings LIMIT 1').get();
    const recipe = getCullRecipe(db, DEFAULT_CULLING_RECIPE_SLUG);
    if (!hasPipeline && recipe) {
      createPipelineSettingVersion(db, defaultPipelineSetting(recipe.slug, recipe.rule), 'default');
    }
    db.prepare('INSERT INTO library_meta (key, value) VALUES (?, ?)').run(CULL_DEFAULTS_SEEDED_META_KEY, nowIsoUtc());
    return true;
  });
}
