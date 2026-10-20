/**
 * The pipeline setting: which culling recipes run, their rules, and the Score forecast threshold.
 * Versioned; exactly one version is current, and every summary row names the version that decided it.
 */
import { parsePipelineSetting } from '../../cull/default-pipeline.js';
import type { PipelineSettingConfig } from '../../cull/types.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { libraryWrite } from './write.js';

export interface PipelineSetting {
  version: number;
  config: PipelineSettingConfig;
}

export function getCurrentPipelineSetting(db: Db): PipelineSetting {
  const row = db
    .prepare('SELECT version, config_json FROM cull_pipeline_settings WHERE is_current = 1')
    .get() as { version: number; config_json: string } | undefined;
  if (!row) throw new Error('library.db has no cull pipeline setting; the cull defaults were never seeded');
  return { version: row.version, config: parsePipelineSetting(JSON.parse(row.config_json)) };
}

/** Write a new version and make it the only current one. Returns its number. */
export function createPipelineSettingVersion(db: Db, config: PipelineSettingConfig, note = ''): number {
  parsePipelineSetting(config);
  return libraryWrite(db, () => {
    db.prepare('UPDATE cull_pipeline_settings SET is_current = 0 WHERE is_current = 1').run();
    const info = db
      .prepare('INSERT INTO cull_pipeline_settings (config_json, is_current, created_at, note) VALUES (?, 1, ?, ?)')
      .run(JSON.stringify(config), nowIsoUtc(), note);
    return Number(info.lastInsertRowid);
  });
}
