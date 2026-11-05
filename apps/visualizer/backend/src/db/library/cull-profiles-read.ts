/**
 * Read culling profiles without pulling in profile save mutations (keeps `cull-sync-stages` acyclic).
 */
import { parseProfileRule } from '../../cull/default-pipeline.js';
import type { ProfileDefinition, ProfileRule } from '../../cull/types.js';
import type { Db } from '../connection.js';

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

export function listCullProfiles(db: Db): CullProfile[] {
  return (db.prepare(`${PROFILE_SELECT} ORDER BY r.id`).all() as ProfileRow[]).map(toProfile);
}

export function getCullProfile(db: Db, slug: string): CullProfile | null {
  const row = db.prepare(`${PROFILE_SELECT} WHERE r.slug = ?`).get(slug) as ProfileRow | undefined;
  return row ? toProfile(row) : null;
}
