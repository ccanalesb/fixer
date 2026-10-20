/**
 * Fake Laya for describe/score/analyze job-handler suites.
 * Must be the first import in those test files (before handlers load).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { LayaAnswerWant } from '../../src/laya/sessions.js';
import { openLibraryDb } from '../../src/db/connection.js';
import { seedCullingDefaults } from '../../src/db/library/cull-recipes.js';
import { fakeLayaRuntimeModule, writeFakeLayaModels } from './fake-laya.js';

const kimiJobLaya = vi.hoisted(() => ({
  scripts: new Map<string, { levels: [number, number, number, number]; p8: number }>(),
  calls: [] as { file: string; want: LayaAnswerWant | undefined }[],
  starts: 0,
  closed: 0,
  forecastOn: true,
  failOn: null as null | string,
  dieOn: null as null | string,
  broken: false,
  startError: null as null | Error,
  cancelAfter: null as null | (() => void),
  sequence: [] as string[],
}));

vi.mock('../../src/laya/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/laya/runtime.js')>();
  return fakeLayaRuntimeModule(actual, kimiJobLaya);
});

export function resetKimiJobLaya(): void {
  kimiJobLaya.scripts.clear();
  kimiJobLaya.calls.length = 0;
  kimiJobLaya.sequence.length = 0;
  kimiJobLaya.starts = 0;
  kimiJobLaya.closed = 0;
  kimiJobLaya.forecastOn = true;
  kimiJobLaya.failOn = null;
  kimiJobLaya.dieOn = null;
  kimiJobLaya.broken = false;
  kimiJobLaya.startError = null;
  kimiJobLaya.cancelAfter = null;
}

export function prepareKimiJobCull(libraryDbPath: string, tempDir: string): string {
  const modelsDir = join(tempDir, 'models');
  writeFakeLayaModels(modelsDir);
  const db = openLibraryDb(libraryDbPath);
  seedCullingDefaults(db);
  db.close();
  return modelsDir;
}

export function writeKimiJobConfig(tempDir: string, modelsDir: string): void {
  writeFileSync(
    join(tempDir, 'config.yaml'),
    `vision_cache_dir: ${join(tempDir, 'vision')}\nlaya_models_dir: ${modelsDir}\n`,
  );
}
