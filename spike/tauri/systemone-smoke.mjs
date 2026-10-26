/**
 * Packaged spike: GET /v1/models and POST /v1/systemone against real ONNX in the model worker.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function sampleRssMiB(pid) {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s*(\d+)\s*kB/m);
      return m ? Math.round(Number(m[1]) / 1024) : null;
    }
    if (process.platform === 'darwin') {
      const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
      const kb = Number(out);
      return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
    }
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`,
        { encoding: 'utf8' },
      ).trim();
      const bytes = Number(out);
      return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
    }
  } catch {
    return null;
  }
  return null;
}

function loadFactoryQuestions(backendRoot) {
  const p = join(backendRoot, 'fixtures', 'factory-questions.json');
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function pickQuestion(modelDir, factory) {
  const rowsPath = join(modelDir, 'reference', 'rows.json');
  if (!existsSync(rowsPath)) throw new Error(`missing ${rowsPath}`);
  const rows = JSON.parse(readFileSync(rowsPath, 'utf8'));
  const qid = Object.keys(rows)[0];
  if (!qid) throw new Error('reference/rows.json has no questions');
  const all = { ...factory.culling_profile, ...factory.score_forecast };
  const q = all[qid];
  if (!q) throw new Error(`factory-questions.json has no entry for ${qid}`);
  return { qid, question: q };
}

function assertProbabilities(answer) {
  if (!answer || typeof answer !== 'object') throw new Error('answer missing');
  const probs = answer.probabilities;
  if (!probs || typeof probs !== 'object') throw new Error('probabilities missing');
  const vals = Object.values(probs).map(Number);
  if (vals.some((v) => !Number.isFinite(v))) throw new Error('non-finite probability');
  const sum = vals.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) throw new Error(`probabilities sum ${sum}, expected ~1`);
}

export async function runSystemOneSmoke(opts) {
  const modelName = opts.modelName ?? 'laya-base';
  const base = `http://127.0.0.1:${opts.port}`;
  const modelDir = join(opts.modelsDir, modelName);
  const photoPath = join(modelDir, 'reference', 'photo.png');
  if (!existsSync(photoPath)) throw new Error(`missing ${photoPath}`);

  const factory = loadFactoryQuestions(opts.backendRoot);
  const { qid, question } = pickQuestion(modelDir, factory);
  const imageB64 = readFileSync(photoPath).toString('base64');

  const checks = {};
  const metrics = {
    modelName,
    modelsDir: opts.modelsDir,
    questionId: qid,
  };

  const rssBefore = sampleRssMiB(opts.backendPid);

  let modelsBody;
  const tModels = performance.now();
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    modelsBody = await res.json();
    const names = (modelsBody.models ?? []).map((m) => m.name);
    if (!names.includes(modelName)) {
      throw new Error(`models=${JSON.stringify(names)} missing ${modelName}`);
    }
    checks['GET /v1/models'] = {
      ok: true,
      detail: `${names.length} model(s): ${names.join(', ')}`,
    };
    metrics.modelsListMs = Math.round(performance.now() - tModels);
  } catch (e) {
    checks['GET /v1/models'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const tPost = performance.now();
  try {
    const res = await fetch(`${base}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify({
        model: modelName,
        images: [imageB64],
        questions: { [qid]: question },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    const body = JSON.parse(text);
    const ans = body.answers?.[qid];
    assertProbabilities(ans);
    checks['POST /v1/systemone'] = {
      ok: true,
      detail: `${qid} type=${ans.type} probs=${JSON.stringify(ans.probabilities)}`,
    };
    metrics.systemOneWallMs = Math.round(performance.now() - tPost);
    metrics.usage = body.usage ?? null;
    metrics.answerType = ans.type;
  } catch (e) {
    checks['POST /v1/systemone'] = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const rssAfter = sampleRssMiB(opts.backendPid);
  metrics.backendRssMiB = { before: rssBefore, after: rssAfter };

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, metrics, modelsBody: modelsBody ?? null };
}
