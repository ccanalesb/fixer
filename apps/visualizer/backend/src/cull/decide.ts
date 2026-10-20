/**
 * Stored answers → verdicts. Pure: no database, no Laya, so a rule or threshold change re-decides
 * every photo from what is stored (ticket 15).
 *
 * Readout as the research ran it (ticket 09): a dimension's answer is its top level, the **first**
 * maximum as numpy's argmax takes it; the imported answers are rounded to 4 decimals and tie often
 * enough (382 of 183k) that the last maximum would change verdicts.
 */
import type {
  CullVerdict,
  PhotoDecision,
  PipelineRecipe,
  PipelineSettingConfig,
  RecipeRule,
  ResolvedStage,
  ScoreForecastSetting,
  StageAnswers,
  StageDecision,
} from './types.js';

/** Laya new's framing excusal question: `[P(no framing device), P(framing device)]`. */
export const FRAMING_EXCUSAL_QID = 'framing-excusal';
const FRAMING_QID = 'framing';

/** 1-based level of the first maximum. */
export function topLevel(probs: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < probs.length; i += 1) if (probs[i]! > probs[best]!) best = i;
  return best + 1;
}

export interface DimensionReadout {
  level: number;
  fails: boolean;
  strong: boolean;
}

export function levelSetReadout(
  answers: StageAnswers,
  bands: { fails_at_most: number; strong_at_least: number },
): Record<string, DimensionReadout> {
  const out: Record<string, DimensionReadout> = {};
  for (const [dim, probs] of Object.entries(answers)) {
    const level = topLevel(probs);
    out[dim] = { level, fails: level <= bands.fails_at_most, strong: level >= bands.strong_at_least };
  }
  return out;
}

/** Whether one level set's answers cut the photo under the recipe's cut rule. */
export function decideRecipeLevelSet(rule: RecipeRule, levelSet: string, answers: StageAnswers): StageDecision {
  const bands = rule.level_sets[levelSet];
  if (!bands) throw new Error(`culling recipe rule has no bands for level set ${levelSet}`);
  const readout = levelSetReadout(answers, bands);
  const dims = Object.values(readout);
  const cr = rule.cut_rule;
  let cut: boolean;
  if (cr.type === 'all_fail') {
    cut = cr.dimensions.every((d) => readout[d]?.fails === true);
  } else if (cr.type === 'n_fail_unless_strong') {
    cut = dims.filter((d) => d.fails).length >= cr.n && !dims.some((d) => d.strong);
  } else {
    cut = dims.length > 0 && dims.reduce((s, d) => s + d.level, 0) / dims.length <= bands.fails_at_most;
  }
  return {
    verdict: cut ? 'cut' : 'sent',
    detail: { level_set: levelSet, bands, cut_rule: cr, readout },
  };
}

/** Highest P(level ≥ `high_from_level`) over Laya new's perspectives, framing left out when excused. */
export function scoreForecastHighestP8(answers: StageAnswers, cfg: ScoreForecastSetting): number {
  const excused = (answers[FRAMING_EXCUSAL_QID]?.[0] ?? 0) >= cfg.excused_at;
  let best = 0;
  for (const [qid, probs] of Object.entries(answers)) {
    if (qid === FRAMING_EXCUSAL_QID || (qid === FRAMING_QID && excused)) continue;
    best = Math.max(best, probs.slice(cfg.high_from_level - 1).reduce((s, p) => s + p, 0));
  }
  return best;
}

export function decideScoreForecast(answers: StageAnswers, cfg: ScoreForecastSetting): StageDecision {
  const p8 = scoreForecastHighestP8(answers, cfg);
  return {
    verdict: p8 < cfg.threshold ? 'cut' : 'sent',
    detail: {
      highest_p8: p8,
      threshold: cfg.threshold,
      framing_excused: (answers[FRAMING_EXCUSAL_QID]?.[0] ?? 0) >= cfg.excused_at,
    },
  };
}

export interface DecideOptions {
  sentByHand?: boolean;
  /** False when Laya new is not set up: the Score forecast stage is off. */
  scoreForecastAvailable?: boolean;
}

function recipeStages(stages: readonly ResolvedStage[], slug: string): ResolvedStage[] {
  return stages.filter((s) => s.kind === 'culling_recipe' && s.recipeSlug === slug);
}

/**
 * Cut, sent, or null while a level set is unanswered: a recipe never cuts on part of its answers.
 * A cut names the recipe's first level set that cut.
 */
function recipeOutcome(
  recipe: PipelineRecipe,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  decisions: Record<string, StageDecision>,
): { verdict: CullVerdict | null; cutStageKey: string | null } {
  const own = recipeStages(stages, recipe.recipe_slug);
  const verdicts: (CullVerdict | null)[] = own.map((s) => {
    const a = answers[s.stageKey];
    if (!a) return null;
    const d = decideRecipeLevelSet(recipe.rule, s.levelSet!, a);
    decisions[s.stageKey] = d;
    return d.verdict;
  });
  const cutStageKey = own[verdicts.indexOf('cut')]?.stageKey ?? null;
  let verdict: CullVerdict | null;
  if (verdicts.length === 0) verdict = null;
  else if (recipe.rule.combine === 'any' && verdicts.includes('cut')) verdict = 'cut';
  else if (verdicts.includes(null)) verdict = null;
  else verdict = verdicts.every((v) => v === 'cut') ? 'cut' : 'sent';
  return { verdict, cutStageKey: verdict === 'cut' ? cutStageKey : null };
}

interface Walk {
  required: ResolvedStage[];
  decision: PhotoDecision;
}

/**
 * Walk the stages in pipeline order — recipes, then the Score forecast — deciding what each says and
 * which still need an answer. A stage switched off for cut photos (`run_after_cut: false`) is only
 * required while nothing before it has cut.
 */
function walk(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): Walk {
  const decisions: Record<string, StageDecision> = {};
  const required: ResolvedStage[] = [];
  let cutBy: PhotoDecision['cutBy'] = null;
  let cutByStageKey: string | null = null;

  for (const recipe of cfg.culling_recipes) {
    if (cutBy !== null && !recipe.run_after_cut) continue;
    required.push(...recipeStages(stages, recipe.recipe_slug));
    const outcome = recipeOutcome(recipe, stages, answers, decisions);
    if (outcome.verdict === 'cut' && cutBy === null) {
      cutBy = 'culling_recipe';
      cutByStageKey = outcome.cutStageKey;
    }
  }

  let scoreForecastP8: number | null = null;
  const sf = cfg.score_forecast;
  const forecastStage = stages.find((s) => s.kind === 'score_forecast');
  if (forecastStage && sf.enabled && opts.scoreForecastAvailable !== false && (cutBy === null || sf.run_after_cut)) {
    required.push(forecastStage);
    const a = answers[forecastStage.stageKey];
    if (a) {
      const d = decideScoreForecast(a, sf);
      decisions[forecastStage.stageKey] = d;
      scoreForecastP8 = d.detail.highest_p8 as number;
      if (d.verdict === 'cut' && cutBy === null) {
        cutBy = 'score_forecast';
        cutByStageKey = forecastStage.stageKey;
      }
    }
  }

  const pendingStages = required.filter((s) => !answers[s.stageKey]).map((s) => s.stageKey);
  const sentByHand = opts.sentByHand === true;
  const decision: PhotoDecision = {
    verdict: sentByHand ? 'sent' : cutBy !== null ? 'cut' : pendingStages.length > 0 ? 'pending' : 'sent',
    cutBy: sentByHand ? null : cutBy,
    cutByStageKey: sentByHand ? null : cutByStageKey,
    pendingStages,
    scoreForecastP8,
    sentByHandOverride: sentByHand && cutBy !== null,
    stages: decisions,
  };
  return { required, decision };
}

/** The stages this photo needs answered under `cfg`, given what is already stored. */
export function requiredStages(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): ResolvedStage[] {
  return walk(cfg, stages, answers, opts).required;
}

/**
 * The photo's summary: cut by a recipe (reported first), else cut by the Score forecast, else
 * pending while a required stage is unanswered (pending is never sent), else sent. Sent by hand wins
 * over all of it, across versions; the stage decisions still say what the stages would have done.
 */
export function decidePhoto(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): PhotoDecision {
  return walk(cfg, stages, answers, opts).decision;
}
