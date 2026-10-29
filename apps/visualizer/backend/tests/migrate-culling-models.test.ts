/**
 * One-shot migration of external culling stage URLs into System One providers.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadLibraryConfig } from '../src/config.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { listProviderModels } from '../src/db/jobs/provider-models.js';
import { migrateCullingModelsIfNeeded } from '../src/providers/migrate-culling-models.js';

let dir: string;
let configPath: string;
let providersPath: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-migrate-cull-'));
  configPath = join(dir, 'config.yaml');
  providersPath = join(dir, 'providers.json');
  dbPath = join(dir, 'visualizer.db');
  writeFileSync(providersPath, JSON.stringify({ providers: {}, defaults: {}, fallback_order: [] }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const yamlBlock = (profile: string, forecast: string) =>
  `culling_models:\n  culling_profile: ${profile}\n  score_forecast: ${forecast}\n`;

describe('migrateCullingModelsIfNeeded', () => {
  it('creates a system_one provider from an external stage and removes URL and key from config.yaml', () => {
    writeFileSync(
      configPath,
      yamlBlock(
        '{endpoint: http://studio.local:8000, model: clef-cull, api_key: sk-a}',
        '{endpoint: this_app, model: "", api_key: ""}',
      ),
    );
    expect(migrateCullingModelsIfNeeded(configPath, providersPath, dbPath)).toBe(true);
    const cfg = loadLibraryConfig(configPath).cullingModels;
    expect(cfg.culling_profile.endpoint).toBe('studio-local-8000');
    expect(cfg.culling_profile.model).toBe('clef-cull');
    const onDisk = parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const stage = (onDisk.culling_models as Record<string, unknown>).culling_profile as Record<string, unknown>;
    expect(stage.api_key).toBeUndefined();
    expect(String(stage.endpoint)).not.toContain('http');
    const providers = JSON.parse(readFileSync(providersPath, 'utf8')).providers;
    expect(providers['studio-local-8000'].protocol).toBe('system_one');
    expect(providers['studio-local-8000'].auth.secret.value).toBe('sk-a');
    const db = initJobsDb(dbPath);
    try {
      expect(listProviderModels(db, 'studio-local-8000').map((r) => r.model_id)).toEqual(['clef-cull']);
    } finally {
      db.close();
    }
  });

  it('two stages on the same URL and key share one provider', () => {
    writeFileSync(
      configPath,
      yamlBlock(
        '{endpoint: http://localhost:11434, model: m1, api_key: k}',
        '{endpoint: http://localhost:11434/, model: m2, api_key: k}',
      ),
    );
    migrateCullingModelsIfNeeded(configPath, providersPath, dbPath);
    const cfg = loadLibraryConfig(configPath).cullingModels;
    expect(cfg.culling_profile.endpoint).toBe('localhost-11434');
    expect(cfg.score_forecast.endpoint).toBe('localhost-11434');
    const providers = JSON.parse(readFileSync(providersPath, 'utf8')).providers;
    expect(Object.keys(providers)).toEqual(['localhost-11434']);
  });

  it('the same URL with different keys gives two providers', () => {
    writeFileSync(
      configPath,
      yamlBlock(
        '{endpoint: http://localhost:11434, model: m1, api_key: k1}',
        '{endpoint: http://localhost:11434, model: m2, api_key: k2}',
      ),
    );
    migrateCullingModelsIfNeeded(configPath, providersPath, dbPath);
    const cfg = loadLibraryConfig(configPath).cullingModels;
    expect(cfg.culling_profile.endpoint).not.toBe(cfg.score_forecast.endpoint);
    const providers = JSON.parse(readFileSync(providersPath, 'utf8')).providers;
    expect(Object.keys(providers).sort()).toEqual(['localhost-11434', 'localhost-11434-2'].sort());
  });

  it('a second run changes nothing', () => {
    writeFileSync(
      configPath,
      yamlBlock('{endpoint: http://127.0.0.1:9, model: x, api_key: k}', '{endpoint: this_app, model: "", api_key: ""}'),
    );
    expect(migrateCullingModelsIfNeeded(configPath, providersPath, dbPath)).toBe(true);
    const afterFirst = readFileSync(configPath, 'utf8');
    expect(migrateCullingModelsIfNeeded(configPath, providersPath, dbPath)).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });
});
