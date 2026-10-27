/**
 * CLIP download progress on the job row, separate from embed progress.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactJobPayload } from '../src/api/schemas/jobs.js';
import { createJob, getJob, initJobsDb } from '../src/db/jobs/jobs.js';
import { JobRunner } from '../src/jobs/runner.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lt-clip-dl-'));
  dbPath = join(dir, 'visualizer.db');
  initJobsDb(dbPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JobRunner.reportClipModelDownload', () => {
  it('writes download bytes on the job without changing embed progress', () => {
    const db = initJobsDb(dbPath);
    const jobId = createJob(db, 'batch_embed_image', {});
    db.prepare("UPDATE jobs SET status = 'running', progress = 40 WHERE id = ?").run(jobId);

    const runner = new JobRunner(db);
    runner.reportClipModelDownload(
      jobId,
      120_000_000,
      351_685_709,
      'Downloading the image model (once) — 120 / 352 MB',
    );

    const row = getJob(db, jobId)!;
    expect(row.progress).toBe(40);
    expect(row.current_step).toBe('Downloading the image model (once) — 120 / 352 MB');
    expect(row.metadata.clip_model_download_loaded_bytes).toBe(120_000_000);
    expect(row.metadata.clip_model_download_total_bytes).toBe(351_685_709);

    const wire = compactJobPayload(row as unknown as Record<string, unknown>);
    expect(wire.clip_model_download_loaded_bytes).toBe(120_000_000);
    expect(wire.clip_model_download_total_bytes).toBe(351_685_709);
    db.close();
  });
});
