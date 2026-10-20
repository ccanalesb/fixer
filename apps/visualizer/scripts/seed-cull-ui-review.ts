/**
 * Seeds a temp library.db for dev-cull-ui.sh (schema 11 + sample cull verdicts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initLibraryDb } from '../backend/src/db/library/bootstrap.js';
import { upsertCullVerdict } from '../backend/src/db/library/cull-verdicts.js';
import { writeFakeLayaModels } from '../backend/tests/helpers/fake-laya.js';

const libPath = process.env.LIBRARY_DB;
const tmpRoot = process.env.CULL_UI_TMP;
if (!libPath || !tmpRoot) {
  console.error('LIBRARY_DB and CULL_UI_TMP required');
  process.exit(1);
}

const vision = join(tmpRoot, 'vision');
const models = join(tmpRoot, 'models');
mkdirSync(vision, { recursive: true });
writeFakeLayaModels(models, { withNew: true });

const db = initLibraryDb(libPath);
const keys = ['photo-cut', 'photo-sent', 'photo-manual'];
const ins = db.prepare('INSERT INTO images (key, filename, filepath) VALUES (?, ?, ?)');
for (const k of keys) {
  const img = join(vision, `${k}.jpg`);
  writeFileSync(img, '');
  ins.run(k, `${k}.jpg`, img);
  db.prepare(
    'INSERT OR IGNORE INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime) VALUES (?, ?, NULL, datetime(\'now\'), 1)',
  ).run(k, img);
}

upsertCullVerdict(db, {
  imageKey: 'photo-cut',
  verdict: 'cut',
  cutBy: 'culling_recipe',
  cutByStageKey: 'culling_recipe:recipe-7h47:7',
  sentByHand: false,
  pendingStages: [],
  pendingReason: '',
  scoreForecastOff: false,
  scoreForecastP8: 0.22,
  pipelineSettingVersion: 1,
  stageVersionIds: [],
  runId: null,
});
upsertCullVerdict(db, {
  imageKey: 'photo-sent',
  verdict: 'sent',
  cutBy: null,
  cutByStageKey: null,
  sentByHand: false,
  pendingStages: [],
  pendingReason: '',
  scoreForecastOff: false,
  scoreForecastP8: null,
  pipelineSettingVersion: 1,
  stageVersionIds: [],
  runId: null,
});
db.close();
console.log(`Seeded ${libPath}`);
