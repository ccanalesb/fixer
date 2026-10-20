/**
 * Culling recipe Laya row length validation on save.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { validateRecipeDefinitionForLaya } from '../src/cull/recipe-validate.js';
import type { RecipeDefinition } from '../src/cull/types.js';

let dir: string;
let configPath: string;

function writeMinimalLaya(modelsDir: string): void {
  const base = join(modelsDir, 'laya-base');
  mkdirSync(join(base, 'tokenizer'), { recursive: true });
  const vocab: Record<string, number> = {};
  for (let i = 0; i < 256; i += 1) vocab[String.fromCharCode(i)] = i + 1;
  writeFileSync(join(base, 'tokenizer', 'tokenizer.json'), JSON.stringify({ model: { vocab } }));
  writeFileSync(join(base, 'tokenizer', 'tokenizer_config.json'), '{}');
  writeFileSync(
    join(base, 'model.json'),
    JSON.stringify({
      temperature: [1, 1, 1],
      temperature_by_options: {},
      max_len: 512,
      head_max_len: 128,
      image_token_id: 1,
      pad_token_id: 0,
      prefix_ids: [1, 2, 3],
    }),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-recipe-val-'));
  const modelsDir = join(dir, 'models');
  writeMinimalLaya(modelsDir);
  configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, `laya_models_dir: ${modelsDir}\n`);
  process.env.LT_CONFIG_YAML = configPath;
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('validateRecipeDefinitionForLaya', () => {
  it('accepts the seeded recipe 7H47 definition', () => {
    const seed = JSON.parse(
      readFileSync(join(REPO_ROOT, 'prompts', 'culling-recipes', 'recipe-7h47.json'), 'utf8'),
    ) as { definition: RecipeDefinition };
    const result = validateRecipeDefinitionForLaya(seed.definition, 'laya-base');
    expect(result.ok).toBe(true);
  });

  it('rejects a question that exceeds max_len', () => {
    writeFileSync(
      join(dir, 'models', 'laya-base', 'model.json'),
      JSON.stringify({
        temperature: [1, 1, 1],
        temperature_by_options: {},
        max_len: 20,
        head_max_len: 8,
        image_token_id: 1,
        pad_token_id: 0,
        prefix_ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      }),
    );
    const def: RecipeDefinition = {
      dimensions: [{ slug: 'd', name: 'D', question: 'x'.repeat(5000) }],
      level_sets: [{ id: '5', levels: { d: ['a', 'b', 'c', 'd', 'e'] } }],
    };
    const result = validateRecipeDefinitionForLaya(def, 'laya-base');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
