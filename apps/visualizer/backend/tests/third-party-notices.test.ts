import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.js';

const saved = process.env.LT_RESOURCES_DIR;

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lt-notices-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env.LT_RESOURCES_DIR;
  else process.env.LT_RESOURCES_DIR = saved;
});

describe('GET /api/system/third-party-notices', () => {
  it('returns the bundled notices file when present', async () => {
    writeFileSync(join(tmp, 'THIRD-PARTY-NOTICES'), 'Sample notices\n');
    process.env.LT_RESOURCES_DIR = tmp;

    const app = createApp();
    const res = await app.request('/api/system/third-party-notices');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Sample notices\n');
  });

  it('returns 404 when the notices file is absent', async () => {
    process.env.LT_RESOURCES_DIR = tmp;

    const app = createApp();
    const res = await app.request('/api/system/third-party-notices');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'Open source license notices are not available in this build.',
    });
  });
});
