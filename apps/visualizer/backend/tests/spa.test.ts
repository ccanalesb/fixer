import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPackagedSpa } from '../src/spa.js';

describe('registerPackagedSpa', () => {
  let resources: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.LT_RESOURCES_DIR;
    resources = mkdtempSync(join(tmpdir(), 'lt-spa-'));
    mkdirSync(join(resources, 'frontend', 'assets'), { recursive: true });
    writeFileSync(join(resources, 'frontend', 'index.html'), '<script src="/assets/index-abc.js">');
    writeFileSync(join(resources, 'frontend', 'assets', 'index-abc.js'), 'console.log(1)');
    process.env.LT_RESOURCES_DIR = resources;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.LT_RESOURCES_DIR;
    else process.env.LT_RESOURCES_DIR = previous;
    rmSync(resources, { recursive: true, force: true });
  });

  function app() {
    const a = new OpenAPIHono();
    registerPackagedSpa(a);
    return a;
  }

  it('makes the webview revalidate index.html at the root and on history fallback', async () => {
    for (const path of ['/', '/index.html', '/catalog']) {
      const res = await app().request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('index-abc.js');
      expect(res.headers.get('Cache-Control')).toBe('no-cache');
    }
  });

  it('lets hashed bundles stay cached', async () => {
    const res = await app().request('/assets/index-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not cache index.html served for a missing bundle', async () => {
    const res = await app().request('/assets/index-gone.js');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });
});
