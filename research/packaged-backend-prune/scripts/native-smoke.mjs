/**
 * Native addon smoke tests — resolves packages from the packaged backend tree.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{ backendRoot: string; onnxPath: string }} opts
 */
export async function runNativeSmoke(opts) {
  const require = createRequire(join(opts.backendRoot, 'package.json'));
  const Database = require('better-sqlite3');
  const sharp = require('sharp');
  const sqliteVec = require('sqlite-vec');
  const ort = require('onnxruntime-node');

  const checks = /** @type {Record<string, { ok: boolean; error?: string; detail?: string }>} */ ({});
  const processInfo = {
    pid: process.pid,
    execPath: process.execPath,
    versions: process.versions,
  };

  try {
    const dir = mkdtempSync(join(tmpdir(), 'lt-spike-sharp-'));
    const src = join(dir, 'in.png');
    writeFileSync(
      src,
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
      })
        .png()
        .toBuffer(),
    );
    const out = await sharp(src).resize(4, 4).raw().toBuffer({ resolveWithObject: true });
    if (out.info.width !== 4 || out.info.height !== 4) {
      throw new Error(`expected 4x4, got ${out.info.width}x${out.info.height}`);
    }
    checks.sharp = { ok: true, detail: `resize ${out.info.width}x${out.info.height}` };
  } catch (e) {
    checks.sharp = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  try {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'lt-spike-sqlite-')), 'test.db');
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE v USING vec0(
        embedding float[2]
      );
    `);
    db.prepare(`INSERT INTO v(embedding) VALUES (?)`).run(
      Buffer.from(new Float32Array([1, 0]).buffer),
    );
    db.prepare(`INSERT INTO v(embedding) VALUES (?)`).run(
      Buffer.from(new Float32Array([0, 1]).buffer),
    );
    const match = db
      .prepare(`SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = 1`)
      .get(Buffer.from(new Float32Array([0.99, 0.01]).buffer));
    db.close();
    if (!match || match.rowid !== 1) {
      throw new Error(`expected rowid 1, got ${JSON.stringify(match)}`);
    }
    checks['better-sqlite3+sqlite-vec'] = { ok: true, detail: `knn rowid=${match.rowid}` };
  } catch (e) {
    checks['better-sqlite3+sqlite-vec'] = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const session = await ort.InferenceSession.create(opts.onnxPath, {
      executionProviders: ['cpu'],
    });
    const input = new ort.Tensor('float32', new Float32Array([1, 2]), [1, 2]);
    const results = await session.run({ X: input });
    const y = results.Y?.data;
    if (!y || y[0] !== 1 || y[1] !== 2) {
      throw new Error(`unexpected output ${y ? [...y] : y}`);
    }
    checks['onnxruntime-node'] = { ok: true, detail: `Identity [${y[0]}, ${y[1]}]` };
  } catch (e) {
    checks['onnxruntime-node'] = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, process: processInfo, backendRoot: opts.backendRoot };
}
