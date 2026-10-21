/**
 * Culling profile mutations beyond the core CRUD in `cull-profiles.ts`.
 */
import { defaultPipelineSetting } from '../../cull/default-pipeline.js';
import type { ProfileDefinition, ProfileRule } from '../../cull/types.js';
import { nowIsoUtc } from '../../utils/datetime.js';
import type { Db } from '../connection.js';
import { createPipelineSettingVersion, getCurrentPipelineSetting } from './cull-pipeline.js';
import {
  createCullProfile,
  definitionHash,
  getCullProfile,
  saveProfileDefinition,
  setProfileRule,
  type CullProfile,
  type NewCullProfile,
} from './cull-profiles.js';
import { libraryWrite } from './write.js';

export function duplicateCullProfile(
  db: Db,
  slug: string,
  newSlug: string,
  newName?: string,
): CullProfile {
  const src = getCullProfile(db, slug);
  if (!src) throw new Error(`no culling profile ${slug}`);
  if (getCullProfile(db, newSlug)) throw new Error(`culling profile ${newSlug} already exists`);
  return createCullProfile(db, {
    slug: newSlug,
    name: newName ?? `${src.name} (copy)`,
    model: src.model,
    definition: structuredClone(src.definition),
    rule: structuredClone(src.rule),
    measured: false,
    active: false,
  });
}

export function updateCullProfileMeta(
  db: Db,
  slug: string,
  patch: { name?: string; model?: string; active?: boolean },
): CullProfile {
  return libraryWrite(db, () => {
    const profile = getCullProfile(db, slug);
    if (!profile) throw new Error(`no culling profile ${slug}`);
    const name = patch.name ?? profile.name;
    const model = patch.model ?? profile.model;
    const active = patch.active ?? profile.active;
    db.prepare('UPDATE cull_profiles SET name = ?, model = ?, active = ?, updated_at = ? WHERE slug = ?').run(
      name,
      model,
      active ? 1 : 0,
      nowIsoUtc(),
      slug,
    );
    return getCullProfile(db, slug)!;
  });
}

/** Add, remove, or reorder a profile in the pipeline config; returns new pipeline version or null. */
export function setCullProfilePipelineActive(db: Db, slug: string, inPipeline: boolean): number | null {
  return libraryWrite(db, () => {
    const profile = getCullProfile(db, slug);
    if (!profile) throw new Error(`no culling profile ${slug}`);
    const { config } = getCurrentPipelineSetting(db);
    const exists = config.culling_profiles.some((r) => r.profile_slug === slug);
    if (inPipeline === exists) return null;
    let next = config.culling_profiles;
    if (inPipeline) {
      next = [...next, { profile_slug: slug, rule: profile.rule, run_after_filtered: true }];
    } else {
      next = next.filter((r) => r.profile_slug !== slug);
    }
    return createPipelineSettingVersion(db, { ...config, culling_profiles: next }, `${slug} pipeline ${inPipeline ? 'on' : 'off'}`);
  });
}

export function saveCullProfileRuleAndBands(db: Db, slug: string, rule: ProfileRule): number | null {
  return setProfileRule(db, slug, rule);
}

export function countCatalogPhotosForCullEstimate(db: Db): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM images i WHERE lower(i.filepath) NOT LIKE '%.mp4' AND lower(i.filepath) NOT LIKE '%.mov'",
    )
    .get() as { n: number };
  return row.n;
}

export function defaultMinimalProfileDefinition(): ProfileDefinition {
  const dim = { slug: 'dimension-1', name: 'Dimension 1', question: '' };
  const levels = ['', '', '', '', ''];
  return {
    dimensions: [dim],
    level_sets: [{ id: '5', levels: { [dim.slug]: levels } }],
  };
}

export function defaultMinimalProfileRule(): ProfileRule {
  return {
    level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
    combine: 'any',
    filter_rule: { type: 'all_fail', dimensions: ['dimension-1'] },
  };
}

export { saveProfileDefinition, definitionHash };
