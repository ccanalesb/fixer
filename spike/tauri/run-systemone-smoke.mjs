/**
 * Host-side CLI: run systemone smoke against a live backend (used from Tauri Rust via sidecar).
 */
import { runSystemOneSmoke } from './systemone-smoke.mjs';

const port = Number(process.env.SPIKE_PORT);
const backendRoot = process.env.SPIKE_BACKEND_ROOT;
const modelsDir = process.env.SPIKE_APP_MODELS_DIR?.trim();
const outPath = process.env.SPIKE_SYSTEMONE_JSON;
const backendPid = process.env.SPIKE_BACKEND_PID
  ? Number(process.env.SPIKE_BACKEND_PID)
  : undefined;

if (!port || !backendRoot || !modelsDir) {
  process.stderr.write('SPIKE_PORT, SPIKE_BACKEND_ROOT, SPIKE_APP_MODELS_DIR required\n');
  process.exit(1);
}

const result = await runSystemOneSmoke({
  port,
  backendRoot,
  modelsDir,
  backendPid,
});

if (outPath) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
}

process.stderr.write(JSON.stringify(result, null, 2) + '\n');
process.exit(result.ok ? 0 : 1);
