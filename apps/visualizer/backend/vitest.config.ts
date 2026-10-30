import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows runners hit SQLite file-lock contention when Vitest files run in parallel,
    // and building an on-disk library fixture per test can take over 30 s there.
    ...(process.platform === 'win32'
      ? {
          maxWorkers: 1,
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 30_000,
        }
      : {}),
  },
});
