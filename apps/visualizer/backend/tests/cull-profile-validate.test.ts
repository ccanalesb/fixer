/**
 * Culling profile text checked on save against the culling profile stage's model, when it is a model in
 * this app.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { validateProfileDefinition } from '../src/cull/profile-validate.js';
import type { ProfileDefinition } from '../src/cull/types.js';

let dir: string;
let modelsDir: string;

const META = {
  temperature: [1, 1, 1],
  temperature_by_options: {},
  max_len: 512,
  head_max_len: 128,
  image_token_id: 1,
  pad_token_id: 0,
  prefix_ids: [1, 2, 3],
};

function writeMinimalModel(name: string): void {
  const model = join(modelsDir, name);
  mkdirSync(join(model, 'tokenizer'), { recursive: true });
  const vocab: Record<string, number> = {};
  for (let i = 0; i < 256; i += 1) vocab[String.fromCharCode(i)] = i + 1;
  writeFileSync(join(model, 'tokenizer', 'tokenizer.json'), JSON.stringify({ model: { vocab } }));
  writeFileSync(join(model, 'tokenizer', 'tokenizer_config.json'), '{}');
  writeFileSync(join(model, 'model.json'), JSON.stringify(META));
}

function useStageModel(endpoint: string, model: string): void {
  writeFileSync(
    join(dir, 'config.yaml'),
    `app_models_dir: ${modelsDir}\nculling_models:\n  culling_profile: {endpoint: ${endpoint}, model: ${model}}\n`,
  );
}

const TOO_LONG: ProfileDefinition = {
  dimensions: [{ slug: 'd', name: 'D', question: 'x'.repeat(5000) }],
  level_sets: [{ id: '5', levels: { d: ['a', 'b', 'c', 'd', 'e'] } }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-profile-val-'));
  modelsDir = join(dir, 'models');
  writeMinimalModel('culling-model');
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  useStageModel('this_app', 'culling-model');
});

afterEach(() => {
  delete process.env.LT_CONFIG_YAML;
  rmSync(dir, { recursive: true, force: true });
});

describe('validateProfileDefinition', () => {
  it('accepts the seeded Default culling profile', () => {
    const seed = JSON.parse(readFileSync(join(REPO_ROOT, 'prompts', 'culling-profiles', 'default.json'), 'utf8')) as {
      definition: ProfileDefinition;
    };
    expect(validateProfileDefinition(seed.definition).ok).toBe(true);
  });

  it("rejects a question longer than the stage model's rows hold", () => {
    writeFileSync(join(modelsDir, 'culling-model', 'model.json'), JSON.stringify({ ...META, max_len: 20, head_max_len: 8 }));
    const result = validateProfileDefinition(TOO_LONG);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('checks only the shape when the stage has no model in this app', () => {
    writeFileSync(join(modelsDir, 'culling-model', 'model.json'), JSON.stringify({ ...META, max_len: 20, head_max_len: 8 }));
    for (const [endpoint, model] of [['this_app', '""'], ['this_app', 'not-installed'], ['http://h:1', 'culling-model']]) {
      useStageModel(endpoint!, model!);
      expect(validateProfileDefinition(TOO_LONG)).toEqual({ ok: true, errors: [] });
    }
    const missing: ProfileDefinition = { ...TOO_LONG, level_sets: [{ id: '5', levels: {} }] };
    expect(validateProfileDefinition(missing).ok).toBe(false);
  });
});
