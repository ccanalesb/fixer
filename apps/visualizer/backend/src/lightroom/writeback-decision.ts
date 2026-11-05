import { countStrongDimensions, ratingFromStrongCount } from './writeback-stars.js';
import { readCurrentStages } from '../cull/stages.js';
import { getCurrentPipelineSetting } from '../db/library/cull-pipeline.js';
import { getCullProfile } from '../db/library/cull-profiles.js';
import { getCullVerdict } from '../db/library/cull-verdicts.js';
import { isSentByHand } from '../db/library/sent-by-hand.js';
import { loadCurrentStageAnswers } from '../db/library/cull-stages.js';
import { isFrameSubstanceVoid } from '../db/library/frame-substance.js';
import type { LrWritebackSettings } from '../db/library/lr-writeback-settings.js';
import type { Db } from '../db/connection.js';

export type RejectWhy =
  | 'setting_off'
  | 'no_verdict'
  | 'sent_by_hand'
  | 'profile_off'
  | 'filtered'
  | 'void_frame'
  | 'passed';

export type StarsWhy = 'no_profile' | 'profile_off' | 'void_frame' | 'none' | 'strong';

export interface WritebackDecision {
  reject: { want: boolean; why: RejectWhy };
  stars: {
    /** What write-back puts in Lightroom: `null` while write stars is off. */
    rating: number | null;
    /** What the strong dimensions earn, whether or not it is written. */
    earnedRating: number | null;
    strong: number;
    profileName: string | null;
    why: StarsWhy;
  };
}

function readStarsProfileStages(db: Db, starsSlug: string) {
  return readCurrentStages(db).stages.filter((s) => s.profileSlug === starsSlug && s.kind === 'culling_profile');
}

function decideReject(
  db: Db,
  settings: LrWritebackSettings,
  imageKey: string,
): WritebackDecision['reject'] {
  if (!settings.write_reject) return { want: false, why: 'setting_off' };
  const verdict = getCullVerdict(db, imageKey);
  if (!verdict) return { want: false, why: 'no_verdict' };
  if (isSentByHand(db, imageKey)) return { want: false, why: 'sent_by_hand' };
  if (!getCurrentPipelineSetting(db).config.culling_profiles_enabled) return { want: false, why: 'profile_off' };
  if (verdict.culling_profile_verdict === 'filtered') return { want: true, why: 'filtered' };
  if (isFrameSubstanceVoid(db, imageKey)) return { want: true, why: 'void_frame' };
  return { want: false, why: 'passed' };
}

function decideStars(
  db: Db,
  settings: LrWritebackSettings,
  imageKey: string,
  starsSlug: string | null,
): WritebackDecision['stars'] {
  if (!starsSlug) return { rating: null, earnedRating: null, strong: 0, profileName: null, why: 'no_profile' };
  const profile = getCullProfile(db, starsSlug);
  if (!profile) return { rating: null, earnedRating: null, strong: 0, profileName: null, why: 'no_profile' };
  if (!getCurrentPipelineSetting(db).config.culling_profiles_enabled) {
    return { rating: null, earnedRating: null, strong: 0, profileName: profile.name, why: 'profile_off' };
  }
  if (isFrameSubstanceVoid(db, imageKey)) {
    return { rating: null, earnedRating: null, strong: 0, profileName: profile.name, why: 'void_frame' };
  }
  const stages = readStarsProfileStages(db, starsSlug);
  const answersByStage = loadCurrentStageAnswers(db, stages, [imageKey]).get(imageKey) ?? {};
  const strong = countStrongDimensions(profile.definition, profile.rule, answersByStage, starsSlug);
  const earnedRating = ratingFromStrongCount(strong);
  const why: StarsWhy = earnedRating === null ? 'none' : 'strong';
  const rating = settings.write_stars ? earnedRating : null;
  return { rating, earnedRating, strong, profileName: profile.name, why };
}

export function decideWriteback(
  db: Db,
  settings: LrWritebackSettings,
  imageKey: string,
  starsSlug: string | null,
): WritebackDecision {
  return {
    reject: decideReject(db, settings, imageKey),
    stars: decideStars(db, settings, imageKey, starsSlug),
  };
}
