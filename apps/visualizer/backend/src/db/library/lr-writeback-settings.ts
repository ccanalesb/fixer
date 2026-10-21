import { getCurrentPipelineSetting } from './cull-pipeline.js';
import { getCullProfile } from './cull-profiles.js';
import type { Db } from '../connection.js';
import { libraryWrite } from './write.js';

export interface LrWritebackSettings {
  write_stars: boolean;
  write_reject: boolean;
  stars_profile_slug: string | null;
}

export function getLrWritebackSettings(db: Db): LrWritebackSettings {
  const row = db
    .prepare('SELECT write_stars, write_reject, stars_profile_slug FROM lr_writeback_settings WHERE id = 1')
    .get() as { write_stars: number; write_reject: number; stars_profile_slug: string | null } | undefined;
  if (!row) {
    return { write_stars: false, write_reject: false, stars_profile_slug: null };
  }
  return {
    write_stars: row.write_stars === 1,
    write_reject: row.write_reject === 1,
    stars_profile_slug: row.stars_profile_slug,
  };
}

export function activePipelineProfileSlugs(db: Db): string[] {
  const pipe = getCurrentPipelineSetting(db);
  return pipe.config.culling_profiles.map((r) => r.profile_slug);
}

export function activePipelineProfiles(db: Db): { slug: string; name: string }[] {
  return activePipelineProfileSlugs(db).map((slug) => {
    const profile = getCullProfile(db, slug);
    return { slug, name: profile?.name ?? slug };
  });
}

/** Slug used for star computation; null when stars are off or pipeline has no profiles. */
export function resolveStarsProfileSlug(db: Db, settings: LrWritebackSettings): string | null {
  const active = activePipelineProfileSlugs(db);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0]!;
  return settings.stars_profile_slug;
}

export interface PatchLrWritebackSettings {
  write_stars?: boolean;
  write_reject?: boolean;
  stars_profile_slug?: string | null;
}

export function patchLrWritebackSettings(db: Db, patch: PatchLrWritebackSettings): LrWritebackSettings {
  return libraryWrite(db, () => {
    const cur = getLrWritebackSettings(db);
    const next: LrWritebackSettings = {
      write_stars: patch.write_stars ?? cur.write_stars,
      write_reject: patch.write_reject ?? cur.write_reject,
      stars_profile_slug: patch.stars_profile_slug !== undefined ? patch.stars_profile_slug : cur.stars_profile_slug,
    };
    db.prepare(
      `UPDATE lr_writeback_settings SET write_stars = ?, write_reject = ?, stars_profile_slug = ? WHERE id = 1`,
    ).run(next.write_stars ? 1 : 0, next.write_reject ? 1 : 0, next.stars_profile_slug);
    return next;
  });
}
