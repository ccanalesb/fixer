/**
 * Cull review read helpers: highlights, sort keys, describe/score completion for send labels.
 */
import { FRAMING_EXCUSAL_QID, levelSetReadout, scoreForecastHighestP8 } from './decide.js';
import { DEFAULT_SCORE_FORECAST } from './default-pipeline.js';
import { LAYA_QUESTIONS } from '../laya/questions.js';
import type { ScoreForecastSetting, StageAnswers } from './types.js';
import { recipeStageKey } from './stages.js';
import type { RecipeDefinition, RecipeRule } from './types.js';
import type { CullRecipe } from '../db/library/cull-recipes.js';
import type { Db } from '../db/connection.js';
import { getCullRecipe } from '../db/library/cull-recipes.js';
import { listPerspectives } from '../db/library/scores.js';
import { computePromptVersion } from '../vision/scoring-service.js';
import type { StageKind } from './types.js';

export type DescribeScoreCompletion = 'none' | 'some' | 'all';

export interface DimensionLevelHighlight {
  level: number;
  fails: boolean;
  strong: boolean;
}

export interface RecipeRowReadout {
  slug: string;
  name: string;
  level_sets: {
    id: string;
    dimensions: { slug: string; name: string; levels: DimensionLevelHighlight[] }[];
  }[];
}

/** Parse `culling_recipe:slug:levelSet` from a verdict's cut stage key. */
export function recipeSlugFromCutStageKey(cutByStageKey: string | null): string | null {
  if (!cutByStageKey?.startsWith('culling_recipe:')) return null;
  const parts = cutByStageKey.split(':');
  return parts.length >= 2 ? parts[1]! : null;
}

/** Build row readout for the recipe that cut the photo (F1), or the first pipeline recipe if unknown. */
export function buildRecipeRowReadout(
  recipe: CullRecipe,
  definition: RecipeDefinition,
  rule: RecipeRule,
  answersByStage: Record<string, Record<string, number[]>>,
): RecipeRowReadout {
  const level_sets = definition.level_sets.map((set) => {
    const stageKey = recipeStageKey(recipe.slug, set.id);
    const answers = answersByStage[stageKey] ?? {};
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
  return { slug: recipe.slug, name: recipe.name, level_sets };
}

export function compareScoreForecastDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function tabMatchesCutBy(tab: 'all' | 'culling_recipe' | 'score_forecast', cutBy: StageKind | null): boolean {
  if (tab === 'all') return true;
  if (tab === 'culling_recipe') return cutBy === 'culling_recipe';
  return cutBy === 'score_forecast';
}

/** Description + current scores on every active perspective (F13/F14). */
export function describeScoreCompletion(db: Db, imageKey: string): DescribeScoreCompletion {
  const described =
    db
      .prepare(
        "SELECT 1 FROM image_descriptions d WHERE d.image_key = ? AND d.image_type = 'catalog' " +
          'AND NOT EXISTS (SELECT 1 FROM vision_stale vs WHERE vs.image_key = d.image_key AND vs.output = ?)',
      )
      .get(imageKey, 'description') !== undefined;
  const active = listPerspectives(db, { activeOnly: true });
  if (active.length === 0) return described ? 'all' : 'none';
  let scored = 0;
  for (const p of active) {
    const version = computePromptVersion({ slug: p.slug, prompt_markdown: p.prompt_markdown });
    const row = db
      .prepare(
        'SELECT 1 FROM image_scores WHERE image_key = ? AND image_type = ? AND perspective_slug = ? AND prompt_version = ? AND is_current = 1',
      )
      .get(imageKey, 'catalog', p.slug, version);
    if (row) scored += 1;
  }
  if (!described && scored === 0) return 'none';
  if (described && scored === active.length) return 'all';
  return 'some';
}

export function resolveCuttingRecipe(db: Db, cutByStageKey: string | null, fallbackSlug: string): CullRecipe | null {
  const slug = recipeSlugFromCutStageKey(cutByStageKey) ?? fallbackSlug;
  return getCullRecipe(db, slug);
}

const FRAMING_QID = 'framing';

/** Per-perspective P(≥ high_from_level) for the detail modal (F3: one decimal in UI). */
export function scoreForecastByPerspective(
  answers: StageAnswers,
  cfg: ScoreForecastSetting = DEFAULT_SCORE_FORECAST,
): { name: string; p8: number }[] {
  const excused = (answers[FRAMING_EXCUSAL_QID]?.[0] ?? 0) >= cfg.excused_at;
  const out: { name: string; p8: number }[] = [];
  for (const [qid, q] of Object.entries(LAYA_QUESTIONS.new)) {
    if (qid === FRAMING_EXCUSAL_QID || (qid === FRAMING_QID && excused)) continue;
    const probs = answers[qid];
    if (!probs?.length) continue;
    const p8 = probs.slice(cfg.high_from_level - 1).reduce((s, p) => s + p, 0);
    const label = q.instructions.split(':')[0]?.trim() ?? qid;
    out.push({ name: label, p8 });
  }
  if (out.length === 0 && Object.keys(answers).length > 0) {
    return [{ name: 'Score forecast', p8: scoreForecastHighestP8(answers, cfg) }];
  }
  return out;
}
