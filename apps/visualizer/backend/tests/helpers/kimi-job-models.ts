/**
 * Fake models for describe/score/analyze job-handler suites.
 * Must be the first import in those test files (before handlers load).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { openLibraryDb } from '../../src/db/connection.js';
import { seedCullingDefaults } from '../../src/db/library/cull-profiles.js';
import {
  fakeModelRuntimeModule,
  fakeModelState,
  THIS_APP_MODELS_YAML,
  writeFakeAppModels,
  type FakeModelState,
} from './fake-app-models.js';

/** Vitest hoisted init cannot call `fakeModelState()`; shape must match — reset uses `fakeModelState()`. */
const kimiJobModels = vi.hoisted(
  (): FakeModelState => ({
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

vi.mock('../../src/app-models/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app-models/runtime.js')>();
  return fakeModelRuntimeModule(actual, kimiJobModels);
});

export function resetKimiJobModels(): void {
  Object.assign(kimiJobModels, fakeModelState());
}

export function prepareKimiJobCull(libraryDbPath: string, tempDir: string): string {
  const modelsDir = join(tempDir, 'models');
  writeFakeAppModels(modelsDir);
  const db = openLibraryDb(libraryDbPath);
  seedCullingDefaults(db);
  db.close();
  return modelsDir;
}

export function writeKimiJobConfig(tempDir: string, modelsDir: string): void {
  writeFileSync(
    join(tempDir, 'config.yaml'),
    `vision_cache_dir: ${join(tempDir, 'vision')}\napp_models_dir: ${modelsDir}\n${THIS_APP_MODELS_YAML}`,
  );
}

/** Mutable fake model state (same object the runtime mock uses). */
export function getKimiJobModels() {
  return kimiJobModels;
}
