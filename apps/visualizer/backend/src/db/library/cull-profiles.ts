/**
 * Culling profiles, like scoring perspectives: a seed file copied into a table once, then edited in the
 * app. The text (dimensions, questions, levels) is versioned — a change makes a new version and, for
 * each level set whose text changed, a new stage version. The rule is not: it is re-decided.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { resourcesRoot } from '../../config.js';
import { defaultPipelineSetting, parseProfileRule } from '../../cull/default-pipeline.js';
import type { ProfileDefinition, ProfileRule } from '../../cull/types.js';
import { canonicalJson } from '../../utils/canonical-json.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from './cull-pipeline.js';
import { libraryWrite } from './write.js';

/** Where the factory culling profiles live. */
export function cullingProfileSeedDir(): string {
  return join(resourcesRoot(), 'prompts', 'culling-profiles');
}

/** The profile the default pipeline setting runs. */
export const DEFAULT_CULLING_PROFILE_SLUG = 'default';

/**
 * Set once the factory profiles and pipeline setting are in. A one-time default, as for perspectives:
 * a user who deletes the seeded profile does not get it back.
 */
export const CULL_DEFAULTS_SEEDED_META_KEY = 'cull_defaults_seeded_v1';

export interface CullProfile {
  id: number;
  slug: string;
  name: string;
  active: boolean;
  measured: boolean;
  rule: ProfileRule;
  versionId: number;
  version: number;
  definition: ProfileDefinition;
}

interface SeedFile {
  slug: string;
  name: string;
  measured?: boolean;
  definition: ProfileDefinition;
  rule: ProfileRule;
}

interface ProfileRow {
  id: number;
  slug: string;
  name: string;
  active: number;
  measured: number;
  rule_json: string;
  version_id: number;
  version: number;
  definition_json: string;
}

const PROFILE_SELECT = `
  SELECT r.id, r.slug, r.name, r.active, r.measured, r.rule_json,
         v.id AS version_id, v.version, v.definition_json
  FROM cull_profiles r
  JOIN cull_profile_versions v ON v.profile_id = r.id AND v.is_current = 1`;

function toProfile(row: ProfileRow): CullProfile {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    active: row.active === 1,
    measured: row.measured === 1,
    rule: parseProfileRule(JSON.parse(row.rule_json)),
    versionId: row.version_id,
    version: row.version,
    definition: JSON.parse(row.definition_json) as ProfileDefinition,
  };
}

export function definitionHash(definition: ProfileDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

export function listCullProfiles(db: Db): CullProfile[] {
  return (db.prepare(`${PROFILE_SELECT} ORDER BY r.id`).all() as ProfileRow[]).map(toProfile);
}

export function getCullProfile(db: Db, slug: string): CullProfile | null {
  const row = db.prepare(`${PROFILE_SELECT} WHERE r.slug = ?`).get(slug) as ProfileRow | undefined;
  return row ? toProfile(row) : null;
}

export interface NewCullProfile {
  slug: string;
  name: string;
  definition: ProfileDefinition;
  rule: ProfileRule;
  measured?: boolean;
  active?: boolean;
  sourceFilename?: string | null;
}

/** Insert a profile at version 1. */
export function createCullProfile(db: Db, r: NewCullProfile): CullProfile {
  const now = nowIsoUtc();
  libraryWrite(db, () => {
    const info = db
      .prepare(
        `INSERT INTO cull_profiles (slug, name, active, rule_json, measured, source_filename, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.slug,
        r.name,
        r.active === false ? 0 : 1,
        JSON.stringify(r.rule),
        r.measured ? 1 : 0,
        r.sourceFilename ?? null,
        now,
        now,
      );
    db.prepare(
      `INSERT INTO cull_profile_versions (profile_id, version, definition_json, content_hash, is_current, created_at)
       VALUES (?, 1, ?, ?, 1, ?)`,
    ).run(Number(info.lastInsertRowid), JSON.stringify(r.definition), definitionHash(r.definition), now);
  });
  return getCullProfile(db, r.slug)!;
}

/**
 * Save a profile's text. A new version only when the text changed; text a past version already had
 * makes that version current again, so its stored answers are current again too.
 */
export function saveProfileDefinition(
  db: Db,
  slug: string,
  definition: ProfileDefinition,
): { versionId: number; version: number; created: boolean } {
  return libraryWrite(db, () => {
    const profile = getCullProfile(db, slug);
    if (!profile) throw new Error(`no culling profile ${slug}`);
    const hash = definitionHash(definition);
    if (hash === definitionHash(profile.definition)) {
      return { versionId: profile.versionId, version: profile.version, created: false };
    }
    const now = nowIsoUtc();
    db.prepare('UPDATE cull_profile_versions SET is_current = 0 WHERE profile_id = ?').run(profile.id);
    const past = db
      .prepare('SELECT id, version FROM cull_profile_versions WHERE profile_id = ? AND content_hash = ?')
      .get(profile.id, hash) as { id: number; version: number } | undefined;
    db.prepare('UPDATE cull_profiles SET updated_at = ? WHERE id = ?').run(now, profile.id);
    if (past) {
      db.prepare('UPDATE cull_profile_versions SET is_current = 1 WHERE id = ?').run(past.id);
      return { versionId: past.id, version: past.version, created: false };
    }
    const { next } = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM cull_profile_versions WHERE profile_id = ?')
      .get(profile.id) as { next: number };
    const info = db
      .prepare(
        `INSERT INTO cull_profile_versions (profile_id, version, definition_json, content_hash, is_current, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(profile.id, next, JSON.stringify(definition), hash, now);
    return { versionId: Number(info.lastInsertRowid), version: next, created: true };
  });
}

/**
 * Change a profile's rule. When the current pipeline setting runs the profile, its snapshot is updated
 * in a new pipeline-setting version: the change is re-decided from stored answers, no model call.
 * Returns the new pipeline-setting version, or null when the profile is not in the pipeline.
 */
export function setProfileRule(db: Db, slug: string, rule: ProfileRule): number | null {
  parseProfileRule(rule);
  return libraryWrite(db, () => {
    const info = db
      .prepare('UPDATE cull_profiles SET rule_json = ?, updated_at = ? WHERE slug = ?')
      .run(JSON.stringify(rule), nowIsoUtc(), slug);
    if (info.changes === 0) throw new Error(`no culling profile ${slug}`);
    const { config } = getCurrentPipelineSetting(db);
    if (!config.culling_profiles.some((r) => r.profile_slug === slug)) return null;
    return createPipelineSettingVersion(
      db,
      {
        ...config,
        culling_profiles: config.culling_profiles.map((r) => (r.profile_slug === slug ? { ...r, rule } : r)),
      },
      `rule of ${slug} changed`,
    );
  });
}

function readSeedFiles(dir: string): { file: string; seed: SeedFile }[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => extname(n).toLowerCase() === '.json')
    .map((file) => ({ file, seed: JSON.parse(readFileSync(join(dir, file), 'utf8')) as SeedFile }));
}

/**
 * Copy the factory profiles into the table and write pipeline-setting version 1, once per library.
 * Returns whether it seeded; the library is marked seeded only once a pipeline setting exists. Runs from
 * `initLibraryDb`; the culling job calls it too, for databases made with the bare schema.
 */
export function seedCullingDefaults(db: Db, dir: string = cullingProfileSeedDir()): boolean {
  const seeded = db.prepare('SELECT 1 FROM library_meta WHERE key = ?').get(CULL_DEFAULTS_SEEDED_META_KEY);
  if (seeded) return false;
  return libraryWrite(db, () => {
    for (const { file, seed } of readSeedFiles(dir)) {
      if (getCullProfile(db, seed.slug)) continue;
      createCullProfile(db, { ...seed, measured: seed.measured ?? false, sourceFilename: file });
    }
    const hasPipeline = () => db.prepare('SELECT 1 FROM cull_pipeline_settings LIMIT 1').get() !== undefined;
    const profile = getCullProfile(db, DEFAULT_CULLING_PROFILE_SLUG);
    if (!hasPipeline() && profile) {
      createPipelineSettingVersion(db, defaultPipelineSetting(profile.slug, profile.rule), 'default');
    }
    // Without a pipeline setting (no seed file found) the next open tries again.
    if (!hasPipeline()) return false;
    db.prepare('INSERT INTO library_meta (key, value) VALUES (?, ?)').run(CULL_DEFAULTS_SEEDED_META_KEY, nowIsoUtc());
    return true;
  });
}
