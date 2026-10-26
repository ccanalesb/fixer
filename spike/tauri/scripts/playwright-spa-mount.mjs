/**
 * Playwright mount test against spike-server (Chromium + WebKit), crossorigin A/B.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE_ROOT = join(HERE, '..');
const REPO_ROOT = join(SPIKE_ROOT, '..', '..');
const FRONTEND = join(REPO_ROOT, 'apps', 'visualizer', 'frontend');
const BACKEND_PACK = join(SPIKE_ROOT, 'backend-pack');

const require = createRequire(join(FRONTEND, 'package.json'));
const { chromium, webkit } = require('playwright');

function pickPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function runNodeServer(port, frontendDist, dataDir) {
  writeFileSync(join(dataDir, 'config.yaml'), 'workers: 1\n');
  return spawn(process.execPath, ['spike-server.mjs'], {
    cwd: BACKEND_PACK,
    env: {
      ...process.env,
      FLASK_HOST: '127.0.0.1',
      FLASK_PORT: String(port),
      SPIKE_FRONTEND_DIST: frontendDist,
      DATABASE_PATH: join(dataDir, 'visualizer.db'),
      LIBRARY_DB: join(dataDir, 'library.db'),
      LT_CONFIG_YAML: join(dataDir, 'config.yaml'),
      LT_PROVIDERS_JSON: join(BACKEND_PACK, 'providers.json'),
      THUMBNAIL_DIR: join(dataDir, 'thumbnails'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHttp(url, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout ${url}`);
}

function makeVariantDir(label, stripCross) {
  const dir = mkdtempSync(join(tmpdir(), `spike-fe-${label}-`));
  cpSync(join(FRONTEND, 'dist'), dir, { recursive: true });
  let html = readFileSync(join(dir, 'index.html'), 'utf8');
  if (stripCross) {
    html = html.replace(/\s+crossorigin/g, '');
  }
  writeFileSync(join(dir, 'index.html'), html, 'utf8');
  return { dir, indexHasCrossorigin: html.includes('crossorigin') };
}

async function playwrightMount(baseUrl, browserName) {
  const browserType = browserName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push({ type: 'pageerror', message: e.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push({ type: 'console', message: msg.text() });
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 });
  let mounted = false;
  let rootChildCount = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    rootChildCount = await page.locator('#root > *').count();
    const hasHeader = await page.locator('header h1').count();
    if (rootChildCount > 0 && hasHeader > 0) {
      mounted = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  await browser.close();
  return { browser: browserName, mounted, rootChildCount, errors };
}

async function runVariant(name, stripCross) {
  if (!existsSync(join(FRONTEND, 'dist/index.html'))) {
    throw new Error('frontend dist missing — run prepare-backend first');
  }
  if (!existsSync(join(BACKEND_PACK, 'spike-server.mjs'))) {
    throw new Error('backend-pack missing — run prepare-backend first');
  }
  const { dir: feDir, indexHasCrossorigin } = makeVariantDir(name, stripCross);
  const dataDir = mkdtempSync(join(tmpdir(), 'spike-pw-data-'));
  mkdirSync(join(dataDir, 'thumbnails'), { recursive: true });
  const port = await pickPort();
  const child = runNodeServer(port, feDir, dataDir);
  const base = `http://127.0.0.1:${port}/`;
  try {
    await waitForHttp(`${base}api/status`, 90_000);
    const chromiumResult = await playwrightMount(base, 'chromium');
    const webkitResult = await playwrightMount(base, 'webkit');
    return {
      variant: name,
      stripCrossorigin: stripCross,
      indexHasCrossorigin,
      port,
      chromium: chromiumResult,
      webkit: webkitResult,
    };
  } finally {
    child.kill('SIGTERM');
    rmSync(feDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const outPath = process.env.SPIKE_PLAYWRIGHT_JSON ?? join(SPIKE_ROOT, 'playwright-mount.json');

const withCross = await runVariant('vite-crossorigin', false);
const stripped = await runVariant('strip-crossorigin', true);

const result = { withCross, stripped };
writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
