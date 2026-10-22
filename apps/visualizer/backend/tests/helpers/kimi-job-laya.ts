/**
 * Fake Laya for describe/score/analyze job-handler suites.
 * Must be the first import in those test files (before handlers load).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openLibraryDb } from '../../src/db/connection.js';
import { seedCullingDefaults } from '../../src/db/library/cull-profiles.js';
import {
  fakeLayaRuntimeModule,
  fakeLayaState,
  writeFakeLayaModels,
  type FakeLayaState,
} from './fake-laya.js';

/** Vitest hoisted init cannot call `fakeLayaState()`; shape must match — reset uses `fakeLayaState()`. */
const kimiJobLaya = vi.hoisted(
  (): FakeLayaState => ({
    scripts: new Map(),
    calls: [],
    checks: 0,
    starts: 0,
    closed: 0,
    failOn: null,
    dieOn: null,
    broken: false,
    startError: null,
    cancelAfter: null,
    sequence: [],
  }),
);

vi.mock('../../src/laya/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/laya/runtime.js')>();
  return fakeLayaRuntimeModule(actual, kimiJobLaya);
});

export function resetKimiJobLaya(): void {
  Object.assign(kimiJobLaya, fakeLayaState());
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

/** Mutable fake-Laya state (same object the runtime mock uses). */
export function getKimiJobLaya() {
  return kimiJobLaya;
}
