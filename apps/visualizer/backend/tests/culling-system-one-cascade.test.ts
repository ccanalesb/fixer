/**
 * System One providers stay out of the description fallback order and cascade.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FallbackDispatcher } from '../src/providers/fallback.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { initJobsDb } from '../src/db/jobs/jobs.js';
import { insertProviderModel } from '../src/db/jobs/provider-models.js';

let dir: string;
let providersPath: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-cascade-'));
  providersPath = join(dir, 'providers.json');
  dbPath = join(dir, 'visualizer.db');
  process.env.LT_PROVIDERS_JSON = providersPath;
  process.env.DATABASE_PATH = dbPath;
  writeFileSync(
    providersPath,
    JSON.stringify(
      {
        fallback_order: ['openai', 'system-one'],
        defaults: { description: { provider: 'openai', model: 'vision-1' } },
        providers: {
          openai: {
            name: 'OpenAI-compatible',
            protocol: 'openai',
            enabled: true,
            base_url: { from: 'literal', value: 'http://127.0.0.1:1/v1' },
            auth: { mode: 'none' },
          },
          'system-one': {
            name: 'Culling host',
            protocol: 'system_one',
            enabled: true,
            base_url: { from: 'literal', value: 'http://127.0.0.1:9000' },
            auth: { mode: 'bearer', secret: { from: 'literal', value: 'k' } },
          },
        },
      },
      null,
      2,
    ),
  );
  const db = initJobsDb(dbPath);
  insertProviderModel(db, {
    providerId: 'openai',
    modelId: 'vision-1',
    modelName: 'Vision One',
    origin: 'config',
    acceptsImages: true,
    refusedReason: null,
  });
  insertProviderModel(db, {
    providerId: 'system-one',
    modelId: 'clef',
    modelName: 'clef',
    origin: 'config',
    acceptsImages: true,
    refusedReason: null,
  });
  db.close();
});

afterEach(() => {
  delete process.env.LT_PROVIDERS_JSON;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('ProviderRegistry fallback order', () => {
  it('lists only OpenAI-compatible providers', () => {
    const registry = new ProviderRegistry(providersPath);
    expect(registry.fallbackOrder).toEqual(['openai']);
    expect(registry.isCascadeEligible('system-one')).toBe(false);
    expect(registry.isCascadeEligible('openai')).toBe(true);
  });
});

describe('FallbackDispatcher', () => {
  it('never attempts a system_one provider after the primary fails', async () => {
    const registry = new ProviderRegistry(providersPath);
    const dispatcher = new FallbackDispatcher(registry);
    const attempts: string[] = [];
    await expect(
      dispatcher.callWithFallback({
        operation: 'describe',
        providerId: 'openai',
        model: 'vision-1',
        fnFactory: (client) => async () => {
          attempts.push(client.providerId);
          throw new Error('fail');
        },
      }),
    ).rejects.toThrow();
    expect(attempts).toEqual(['openai']);
    expect(attempts).not.toContain('system-one');
  });
});
