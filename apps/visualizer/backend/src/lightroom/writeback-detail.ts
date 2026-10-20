import { countStrongDimensions, ratingFromStrongCount } from './writeback-stars.js';
import { resolveCurrentStages } from '../cull/stages.js';
import type { Db } from '../db/connection.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { loadCurrentStageAnswers, readStoredLayaModelIds } from '../db/library/cull-stages.js';
import { getWritebackState } from '../db/library/lr-writeback-state.js';
import { resolveStarsRecipeSlug, type LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import {
  AUTO_REJECT_KEYWORD,
  AUTO_STARS_KEYWORD,
  connectCatalog,
  imageHasKeywordByKey,
  readPickRating,
} from './writer.js';

export function buildWritebackPhotoDetail(
  db: Db,
  catalogPath: string,
  imageKey: string,
  settings: LrWritebackSettings,
) {
  const starsSlug = resolveStarsRecipeSlug(db, settings);
  const starsRow = getWritebackState(db, imageKey, 'stars');
  const rejectRow = getWritebackState(db, imageKey, 'reject');

  const conn = connectCatalog(catalogPath);
  let live = null as ReturnType<typeof readPickRating>;
  const keywords: string[] = [];
  try {
    live = readPickRating(conn, imageKey);
    if (imageHasKeywordByKey(conn, imageKey, AUTO_STARS_KEYWORD)) keywords.push(AUTO_STARS_KEYWORD);
    if (imageHasKeywordByKey(conn, imageKey, AUTO_REJECT_KEYWORD)) keywords.push(AUTO_REJECT_KEYWORD);
  } finally {
    conn.close();
  }

  let strongLine: string | null = null;
  if (starsSlug) {
    const recipe = getCullRecipe(db, starsSlug);
    if (recipe) {
      const modelIds = readStoredLayaModelIds(db);
      const pipe = getCurrentPipelineSetting(db);
      const stages = modelIds
        ? resolveCurrentStages(db, pipe.config, modelIds).filter(
            (s) => s.recipeSlug === starsSlug && s.kind === 'culling_recipe',
          )
        : [];
      const answers = loadCurrentStageAnswers(db, stages, [imageKey]).get(imageKey) ?? {};
      const count = countStrongDimensions(recipe.definition, recipe.rule, answers, starsSlug);
      const rating = ratingFromStrongCount(count);
      strongLine =
        rating === null
          ? `Strong dimensions (${recipe.name}): none`
          : `Strong dimensions (${recipe.name}): ${count} strong → ${'★'.repeat(rating)}`;
    }
  }

  const ratingUserChanged =
    starsRow?.status === 'written' && live !== null && live.rating !== starsRow.written_rating;
  const flagUserChanged = rejectRow?.status === 'written' && live !== null && live.pick !== rejectRow.written_pick;

  return {
    image_key: imageKey,
    rating: {
      live: live?.rating ?? null,
      app_wrote: starsRow?.status === 'written',
      before_label: starsRow?.before_rating === null ? 'before: no rating' : null,
      undo_available:
        starsRow?.status === 'written' &&
        live !== null &&
        live.rating === starsRow.written_rating &&
        !ratingUserChanged,
      user_changed: Boolean(ratingUserChanged),
    },
    flag: {
      live_pick: live?.pick ?? null,
      app_wrote_reject: rejectRow?.status === 'written',
      undo_available:
        rejectRow?.status === 'written' && live !== null && live.pick === rejectRow.written_pick && !flagUserChanged,
      user_changed: Boolean(flagUserChanged),
    },
    keywords,
    strong_dimensions_line: strongLine,
  };
}
