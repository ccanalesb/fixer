/**
 * Packaged backend child entry (lives in resources/backend after prepare-backend).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNativeSmoke } from './native-smoke.mjs';

const backendRoot = process.cwd();
const resultPath = process.env.SPIKE_RESULT_PATH;
const onnxPath = join(backendRoot, 'fixtures', 'tiny.onnx');

const smoke = await runNativeSmoke({ backendRoot, onnxPath });

if (resultPath) {
  writeFileSync(
    resultPath,
    JSON.stringify({ phase: 'native-smoke', ...smoke }, null, 2),
    'utf8',
  );
}

if (!smoke.ok) {
  process.stderr.write(`native smoke failed: ${JSON.stringify(smoke.checks)}\n`);
  process.exit(1);
}

if (process.env.SPIKE_SMOKE_ONLY === '1') {
  process.exit(0);
}

await import(pathToFileURL(join(backendRoot, 'spike-server.mjs')).href);
