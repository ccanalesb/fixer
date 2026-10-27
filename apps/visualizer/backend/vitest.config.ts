import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows runners hit SQLite file-lock contention when Vitest files run in parallel.
    ...(process.platform === 'win32'
      ? {
          maxWorkers: 1,
          fileParallelism: false,
          hookTimeout: 30_000,
          testTimeout: 30_000,
        }
      : {}),
  },
});
