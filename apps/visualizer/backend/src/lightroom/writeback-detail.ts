import { decideWriteback } from './writeback-decision.js';
import type { Db } from '../db/connection.js';
import { getWritebackState } from '../db/library/lr-writeback-state.js';
import { resolveStarsProfileSlug, type LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import { liveMatchesWritten, userChangedAfterWrite } from './writeback-shared.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  connectCatalog,
  imageHasKeywordByKey,
  readPickRating,
} from './writer.js';

function strongDimensionsLine(decision: ReturnType<typeof decideWriteback>['stars']): string | null {
  switch (decision.why) {
    case 'no_profile':
      return null;
    case 'void_frame':
      return 'No stars: void frame';
    case 'profile_off':
      return 'No stars: the culling profile is off';
    case 'none':
      return `Strong dimensions (${decision.profileName}): none`;
    case 'strong':
      return `Strong dimensions (${decision.profileName}): ${decision.strong} strong → ${'★'.repeat(decision.earnedRating ?? 0)}`;
  }
}

export function buildWritebackPhotoDetail(
  db: Db,
  catalogPath: string,
  imageKey: string,
  settings: LrWritebackSettings,
) {
  const starsSlug = resolveStarsProfileSlug(db, settings);
  const starsRow = getWritebackState(db, imageKey, 'stars');
  const rejectRow = getWritebackState(db, imageKey, 'reject');
  const decision = decideWriteback(db, settings, imageKey, starsSlug);

  const conn = connectCatalog(catalogPath, db);
  let live = null as ReturnType<typeof readPickRating>;
  const keywords: string[] = [];
  try {
    live = readPickRating(conn, imageKey);
    if (imageHasKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD)) keywords.push(AUTO_STARS_KEYWORD);
    if (imageHasKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD)) keywords.push(AUTO_REJECT_KEYWORD);
  } finally {
    conn.close();
  }

  const ratingUserChanged = starsRow && live && userChangedAfterWrite('stars', live, starsRow);
  const flagUserChanged = rejectRow && live && userChangedAfterWrite('reject', live, rejectRow);

  return {
    image_key: imageKey,
    rating: {
      live: live?.rating ?? null,
      app_wrote: starsRow?.status === 'written',
      before_label: starsRow?.before_rating === null ? 'before: no rating' : null,
      undo_available:
        starsRow?.status === 'written' &&
        live !== null &&
        liveMatchesWritten('stars', live, starsRow) &&
        !ratingUserChanged,
      user_changed: Boolean(ratingUserChanged),
    },
    flag: {
      live_pick: live?.pick ?? null,
      app_wrote_reject: rejectRow?.status === 'written',
      undo_available:
        rejectRow?.status === 'written' &&
        live !== null &&
        liveMatchesWritten('reject', live, rejectRow) &&
        !flagUserChanged,
      user_changed: Boolean(flagUserChanged),
    },
    keywords,
    strong_dimensions_line: strongDimensionsLine(decision.stars),
  };
}
