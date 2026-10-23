/**
 * Cull review read helpers: highlights, sort keys, describe/score completion for send labels.
 */
import { excusedQuestions, levelSetReadout, pAtLeast } from './decide.js';
import type { ScoreForecastQuestion } from './forecast-questions.js';
import type { ScoreForecastSetting, StageAnswers } from './types.js';
import { profileStageKey } from './stages.js';
import type { ProfileDefinition, ProfileRule } from './types.js';
import type { CullProfile } from '../db/library/cull-profiles.js';
import type { Db } from '../db/connection.js';
import { getCullProfile } from '../db/library/cull-profiles.js';
import {
  batchDescribeScoreCompletion,
  type DescribeScoreCompletion,
} from '../db/library/cull-completion.js';
import type { StageKind } from './types.js';

export type { DescribeScoreCompletion };
export { batchDescribeScoreCompletion };

export interface DimensionLevelHighlight {
  level: number;
  fails: boolean;
  strong: boolean;
}

export interface ProfileRowReadout {
  slug: string;
  name: string;
  level_sets: {
    id: string;
    dimensions: { slug: string; name: string; levels: DimensionLevelHighlight[] }[];
  }[];
}

/** Map stored question ids (`{levelSet}|{dim}`) to dimension slugs for readout. */
export function answersForLevelSetDimensions(
  answers: StageAnswers,
  levelSetId: string,
  dimensionSlugs: readonly string[],
): StageAnswers {
  const out: StageAnswers = {};
  for (const slug of dimensionSlugs) {
    const qid = `${levelSetId}|${slug}`;
    if (answers[qid] !== undefined) out[slug] = answers[qid]!;
    else if (answers[slug] !== undefined) out[slug] = answers[slug]!;
  }
  return out;
}

/** Parse `culling_profile:slug:levelSet` from a verdict's filtered-by stage key. */
export function profileSlugFromFilteredStageKey(filteredByStageKey: string | null): string | null {
  if (!filteredByStageKey?.startsWith('culling_profile:')) return null;
  const parts = filteredByStageKey.split(':');
  return parts.length >= 2 ? parts[1]! : null;
}

/** Build row readout for the profile that filtered the photo (F1), or the first pipeline profile if unknown. */
export function buildProfileRowReadout(
  profile: CullProfile,
  definition: ProfileDefinition,
  rule: ProfileRule,
  answersByStage: Record<string, Record<string, number[]>>,
): ProfileRowReadout {
  const level_sets = definition.level_sets.map((set) => {
    const stageKey = profileStageKey(profile.slug, set.id);
    const raw = answersByStage[stageKey] ?? {};
    const dimSlugs = definition.dimensions.map((d) => d.slug);
    const answers = answersForLevelSetDimensions(raw, set.id, dimSlugs);
    const bands = rule.level_sets[set.id];
    const readout = bands ? levelSetReadout(answers, bands) : {};
    return {
      id: set.id,
      dimensions: definition.dimensions.map((dim) => {
        const r = readout[dim.slug];
        const nLevels = set.levels[dim.slug]?.length ?? 0;
        return {
          slug: dim.slug,
          name: dim.name,
          levels: r
            ? [{ level: r.level, fails: r.fails, strong: r.strong }]
            : [{ level: 0, fails: false, strong: false }],
        };
      }),
    };
  });
  return { slug: profile.slug, name: profile.name, level_sets };
}

export function compareScoreForecastDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function tabMatchesFilteredBy(tab: 'all' | 'culling_profile' | 'score_forecast', filteredBy: StageKind | null): boolean {
  if (tab === 'all') return true;
  if (tab === 'culling_profile') return filteredBy === 'culling_profile';
  return filteredBy === 'score_forecast';
}

/** Description + current scores on every active perspective (F13/F14). */
export function describeScoreCompletion(db: Db, imageKey: string): DescribeScoreCompletion {
  return batchDescribeScoreCompletion(db, [imageKey]).get(imageKey) ?? 'none';
}

export function resolveFilteringProfile(db: Db, filteredByStageKey: string | null, fallbackSlug: string): CullProfile | null {
  const slug = profileSlugFromFilteredStageKey(filteredByStageKey) ?? fallbackSlug;
  return getCullProfile(db, slug);
}

export interface ForecastByQuestion {
  name: string;
  /** Null when the photo is excused from the question: its "applies?" said no. */
  p8: number | null;
  excused: boolean;
}

/**
 * P(≥ `high_from_level`) per Score forecast question for the detail modal (one decimal in the UI), named
 * by the question's perspective when it has one. An excused question is listed as not applying.
 */
export function scoreForecastByQuestion(
  answers: StageAnswers,
  cfg: ScoreForecastSetting,
  questions: readonly ScoreForecastQuestion[],
  perspectiveNames: Readonly<Record<string, string>>,
): ForecastByQuestion[] {
  const excused = new Set(excusedQuestions(answers, cfg));
  return questions
    .filter((q) => answers[q.id]?.length)
    .map((q) => ({
      name: (q.perspective_slug && perspectiveNames[q.perspective_slug]) || q.name,
      p8: excused.has(q.id) ? null : pAtLeast(answers[q.id]!, cfg),
      excused: excused.has(q.id),
    }));
}
