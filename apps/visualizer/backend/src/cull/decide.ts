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
  PipelineProfile,
  PipelineSettingConfig,
  ProfileRule,
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

/** Whether one level set's answers filter the photo under the profile's filter rule. */
export function decideProfileLevelSet(rule: ProfileRule, levelSet: string, answers: StageAnswers): StageDecision {
  const bands = rule.level_sets[levelSet];
  if (!bands) throw new Error(`culling profile rule has no bands for level set ${levelSet}`);
  const readout = levelSetReadout(answers, bands);
  const dims = Object.values(readout);
  const cr = rule.filter_rule;
  let filtered: boolean;
  if (cr.type === 'all_fail') {
    filtered = cr.dimensions.every((d) => readout[d]?.fails === true);
  } else if (cr.type === 'n_fail_unless_strong') {
    filtered = dims.filter((d) => d.fails).length >= cr.n && !dims.some((d) => d.strong);
  } else {
    filtered = dims.length > 0 && dims.reduce((s, d) => s + d.level, 0) / dims.length <= bands.fails_at_most;
  }
  return {
    verdict: filtered ? 'filtered' : 'passed',
    detail: { level_set: levelSet, bands, filter_rule: cr, readout },
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
    verdict: p8 < cfg.threshold ? 'filtered' : 'passed',
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

function profileStages(stages: readonly ResolvedStage[], slug: string): ResolvedStage[] {
  return stages.filter((s) => s.kind === 'culling_profile' && s.profileSlug === slug);
}

/**
 * Filtered, passed, or null while a level set is unanswered: a profile never filters on part of its
 * answers. A filtered verdict names the profile's first level set that filtered.
 */
function profileOutcome(
  profile: PipelineProfile,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  decisions: Record<string, StageDecision>,
): { verdict: CullVerdict | null; filteredStageKey: string | null } {
  const own = profileStages(stages, profile.profile_slug);
  const verdicts: (CullVerdict | null)[] = own.map((s) => {
    const a = answers[s.stageKey];
    if (!a) return null;
    const d = decideProfileLevelSet(profile.rule, s.levelSet!, a);
    decisions[s.stageKey] = d;
    return d.verdict;
  });
  const filteredStageKey = own[verdicts.indexOf('filtered')]?.stageKey ?? null;
  let verdict: CullVerdict | null;
  if (verdicts.length === 0) verdict = null;
  else if (profile.rule.combine === 'any' && verdicts.includes('filtered')) verdict = 'filtered';
  else if (verdicts.includes(null)) verdict = null;
  else verdict = verdicts.every((v) => v === 'filtered') ? 'filtered' : 'passed';
  return { verdict, filteredStageKey: verdict === 'filtered' ? filteredStageKey : null };
}

interface Walk {
  required: ResolvedStage[];
  decision: PhotoDecision;
}

/**
 * Walk the stages in pipeline order — profiles, then the Score forecast — deciding what each says and
 * which still need an answer. A stage switched off for filtered photos (`run_after_filtered: false`) is
 * only required while nothing before it has filtered.
 */
function walk(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): Walk {
  const decisions: Record<string, StageDecision> = {};
  const required: ResolvedStage[] = [];
  let filteredBy: PhotoDecision['filteredBy'] = null;
  let filteredByStageKey: string | null = null;

  for (const profile of cfg.culling_profiles) {
    if (filteredBy !== null && !profile.run_after_filtered) continue;
    required.push(...profileStages(stages, profile.profile_slug));
    const outcome = profileOutcome(profile, stages, answers, decisions);
    if (outcome.verdict === 'filtered' && filteredBy === null) {
      filteredBy = 'culling_profile';
      filteredByStageKey = outcome.filteredStageKey;
    }
  }

  let scoreForecastP8: number | null = null;
  const sf = cfg.score_forecast;
  const forecastStage = stages.find((s) => s.kind === 'score_forecast');
  if (forecastStage && sf.enabled && opts.scoreForecastAvailable !== false && (filteredBy === null || sf.run_after_filtered)) {
    required.push(forecastStage);
    const a = answers[forecastStage.stageKey];
    if (a) {
      const d = decideScoreForecast(a, sf);
      decisions[forecastStage.stageKey] = d;
      scoreForecastP8 = d.detail.highest_p8 as number;
      if (d.verdict === 'filtered' && filteredBy === null) {
        filteredBy = 'score_forecast';
        filteredByStageKey = forecastStage.stageKey;
      }
    }
  }

  const pendingStages = required.filter((s) => !answers[s.stageKey]).map((s) => s.stageKey);
  const sentByHand = opts.sentByHand === true;
  const decision: PhotoDecision = {
    verdict: sentByHand ? 'passed' : filteredBy !== null ? 'filtered' : pendingStages.length > 0 ? 'pending' : 'passed',
    filteredBy: sentByHand ? null : filteredBy,
    filteredByStageKey: sentByHand ? null : filteredByStageKey,
    pendingStages,
    scoreForecastP8,
    sentByHandOverride: sentByHand && filteredBy !== null,
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
 * The photo's summary: filtered by a profile (reported first), else filtered by the Score forecast,
 * else pending while a required stage is unanswered (pending never passes), else passed. Sent by hand wins
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
