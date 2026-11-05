/**
 * The culling and write-back GETs read `library.db` on a read-only connection and take the stage versions
 * that are current, even when one is missing: reading never makes a version current.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { createApp } from '../src/app.js';
import { syncCurrentStages } from '../src/cull/stages.js';
import { getCurrentPipelineSetting } from '../src/db/library/cull-pipeline.js';
import { getCullProfile, saveProfileDefinition } from '../src/db/library/cull-profiles.js';
import { upsertStageAnswer } from '../src/db/library/cull-stages.js';
import { upsertCullVerdict } from '../src/db/library/cull-verdicts.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { makeFakeCatalog } from './helpers/fake-catalog.js';

const opened = vi.hoisted(() => [] as { readonly: boolean }[]);

vi.mock('../src/db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/connection.js')>();
  return {
    ...actual,
    openLibraryDb: (path: string, opts: Parameters<typeof actual.openLibraryDb>[1] = {}) => {
      opened.push({ readonly: opts.readonly === true });
      return actual.openLibraryDb(path, opts);
    },
  };
});

const app = createApp();
const KEY = '2024-06-01_photo';
const MODEL_IDS = { culling_profile: 'test-culling-model', score_forecast: null };

let fx: LibraryFixture;
let dir: string;

type Detail = { profile: { level_sets: { id: string; dimensions: { slug: string; levels: { level: number }[] }[] }[] } };

function stageVersions(): { id: number; is_current: number }[] {
  return fx.query<{ id: number; is_current: number }>('SELECT id, is_current FROM cull_stage_versions ORDER BY id');
}

beforeEach(() => {
  fx = new LibraryFixture().addImage({ key: KEY, id: '1' }).cullingStagesOn().activate();
  dir = mkdtempSync(join(tmpdir(), 'lt-cull-reads-'));
  const lrcatPath = join(dir, 'Test.lrcat');
  writeFileSync(join(dir, 'config.yaml'), stringifyYaml({ workers: 4, catalog_path: lrcatPath }));
  process.env.LT_CONFIG_YAML = join(dir, 'config.yaml');
  process.env.DATABASE_PATH = join(dir, 'visualizer.db');
  makeFakeCatalog(lrcatPath, [{ id: 1, baseName: 'photo', pick: 0, rating: null }]);
  fx.withDb((db) => {
    const stages = syncCurrentStages(db, MODEL_IDS);
    const seven = stages.find((s) => s.stageKey === 'culling_profile:default:7')!;
    upsertStageAnswer(db, {
      imageKey: KEY,
      stageVersionId: seven.versionId,
      answers: { '7|immediate-impact': [0, 0, 0, 0, 0, 1, 0] },
      verdict: 'passed',
      decision: {},
      pipelineSettingVersion: getCurrentPipelineSetting(db).version,
      source: 'job',
      runId: 1,
    });
    upsertCullVerdict(db, {
      imageKey: KEY,
      verdict: 'passed',
      filteredBy: null,
      filteredByStageKey: null,
      cullingProfileVerdict: 'passed',
      sentByHand: false,
      pendingStages: [],
      pendingReason: '',
      scoreForecastOff: true,
      scoreForecastP8: null,
      pipelineSettingVersion: 1,
      stageVersionIds: [],
      runId: null,
    });
  });
});

afterEach(() => {
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LT_CONFIG_YAML;
  delete process.env.DATABASE_PATH;
});

const GETS = ['/api/cull/photos/', `/api/cull/photos/${KEY}`, `/api/cull/lightroom-writeback/photos/${KEY}`];

describe('culling and write-back GETs', () => {
  it('open library.db read-only', async () => {
    for (const path of GETS) {
      opened.length = 0;
      expect((await app.request(path)).status).toBe(200);
      expect(opened.length).toBeGreaterThan(0);
      expect(opened.every((o) => o.readonly)).toBe(true);
    }
  });

  it('leave a stage with no current version as it is', async () => {
    fx.withDb((db) => db.prepare("UPDATE cull_stage_versions SET is_current = 0 WHERE stage_key = 'culling_profile:default:7'").run());
    const before = stageVersions();
    for (const path of GETS) expect((await app.request(path)).status).toBe(200);
    expect(stageVersions()).toEqual(before);
  });

  it('show the new current version after a profile text change, with no answers yet', async () => {
    const level = (body: Detail) =>
      body.profile.level_sets.find((s) => s.id === '7')!.dimensions.find((d) => d.slug === 'immediate-impact')!.levels[0]!.level;
    const answered = (await (await app.request(`/api/cull/photos/${KEY}`)).json()) as Detail;
    expect(level(answered)).toBeGreaterThan(0);

    fx.withDb((db) => {
      const profile = getCullProfile(db, 'default')!;
      const definition = structuredClone(profile.definition);
      const set = definition.level_sets.find((s) => s.id === '7')!;
      set.levels['immediate-impact']![6] = `${set.levels['immediate-impact']![6]} (edited)`;
      saveProfileDefinition(db, 'default', definition);
    });
    const before = stageVersions();
    const unanswered = (await (await app.request(`/api/cull/photos/${KEY}`)).json()) as Detail;
    expect(level(unanswered)).toBe(0);
    expect(stageVersions()).toEqual(before);
  });
});
