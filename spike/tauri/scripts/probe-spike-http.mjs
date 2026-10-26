/**
 * HTTP probe for spike-server (run while backend listens on SPIKE_PORT).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.SPIKE_PORT);
const out = process.env.SPIKE_HTTP_PROBE_JSON;
const frontendRoot = process.env.SPIKE_FRONTEND_DIST;

if (!port || !out || !frontendRoot) {
  process.stderr.write('SPIKE_PORT, SPIKE_HTTP_PROBE_JSON, SPIKE_FRONTEND_DIST required\n');
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const indexHtml = readFileSync(join(frontendRoot, 'index.html'), 'utf8');
const jsMatch = indexHtml.match(/src="(\/assets\/[^"]+\.js)"/);
const cssMatch = indexHtml.match(/href="(\/assets\/[^"]+\.css)"/);
const jsPath = jsMatch?.[1] ?? '/assets/missing.js';
const cssPath = cssMatch?.[1] ?? '/assets/missing.css';

async function probe(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const ct = res.headers.get('content-type') ?? '';
  const buf = await res.arrayBuffer();
  const head = new TextDecoder().decode(buf.slice(0, 120));
  const looksLikeHtml = head.trimStart().startsWith('<!') || head.includes('<html');
  return {
    url,
    status: res.status,
    contentType: ct,
    bytes: buf.byteLength,
    looksLikeHtml,
    headSample: head.slice(0, 80),
    csp: res.headers.get('content-security-policy'),
    cors: res.headers.get('access-control-allow-origin'),
  };
}

const probes = {
  base,
  indexHasCrossorigin: /\scrossorigin/.test(indexHtml),
  requests: [],
};

for (const path of ['/', jsPath, cssPath, '/assets/nonexistent-spike-probe.js', '/images']) {
  try {
    probes.requests.push(await probe(`${base}${path}`));
  } catch (e) {
    probes.requests.push({
      url: `${base}${path}`,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

writeFileSync(out, JSON.stringify(probes, null, 2), 'utf8');
process.stdout.write(JSON.stringify(probes, null, 2) + '\n');
