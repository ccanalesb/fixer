/**
 * Stored answers → verdicts. Pure: no database, no Laya, so a rule or threshold change re-decides
 * every photo from what is stored (ticket 15).
 *
 * Readout as the research ran it (ticket 09): a dimension's answer is its top level, the **first**
 * maximum as numpy's argmax takes it; the imported answers are rounded to 4 decimals and tie often
 * enough (382 of 183k) that the last maximum would change verdicts.
 */
import { EXCUSAL_SUFFIX, excusalId } from './forecast-questions.js';
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

/**
 * Optional questions the photo is excused from: their "applies?" answer, `[P(no), P(yes)]`, says no at
 * `excused_at` or more.
 */
export function excusedQuestions(answers: StageAnswers, cfg: ScoreForecastSetting): string[] {
  return Object.keys(answers).filter((qid) => {
    const pNo = answers[excusalId(qid)]?.[0];
    return !qid.endsWith(EXCUSAL_SUFFIX) && pNo !== undefined && pNo >= cfg.excused_at;
  });
}

/** P(level ≥ `high_from_level`) of one question's answer. */
export const pAtLeast = (probs: readonly number[], cfg: ScoreForecastSetting): number =>
  probs.slice(cfg.high_from_level - 1).reduce((s, p) => s + p, 0);

/** Highest P(level ≥ `high_from_level`) over the Score forecast questions, excused ones left out. */
export function scoreForecastHighestP8(answers: StageAnswers, cfg: ScoreForecastSetting): number {
  const excused = new Set(excusedQuestions(answers, cfg));
  let best = 0;
  for (const [qid, probs] of Object.entries(answers)) {
    if (qid.endsWith(EXCUSAL_SUFFIX) || excused.has(qid)) continue;
    best = Math.max(best, pAtLeast(probs, cfg));
  }
  return best;
}

export function decideScoreForecast(answers: StageAnswers, cfg: ScoreForecastSetting): StageDecision {
  const p8 = scoreForecastHighestP8(answers, cfg);
  return {
    verdict: p8 < cfg.threshold ? 'filtered' : 'passed',
    detail: { highest_p8: p8, threshold: cfg.threshold, excused: excusedQuestions(answers, cfg) },
  };
}

export interface DecideOptions {
  sentByHand?: boolean;
  /** False when the Score forecast has no model identity: the stage is off. */
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
 * Every stage that is on is required on every photo: the culling profiles while they are on (stars and
 * reject need them), the Score forecast while it is on. Only the stages that filter can hold a photo
 * pending; a culling profile with its filter off is still asked, for Lightroom, but never holds one back.
 */
function walk(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): Walk {
  const decisions: Record<string, StageDecision> = {};
  const required: ResolvedStage[] = [];
  const deciding: ResolvedStage[] = [];
  let filteredBy: PhotoDecision['filteredBy'] = null;
  let filteredByStageKey: string | null = null;

  let cullingProfileVerdict: CullVerdict | null = null;
  if (cfg.culling_profiles_enabled && cfg.culling_profiles.length > 0) {
    const outcomes = cfg.culling_profiles.map((profile) => {
      const own = profileStages(stages, profile.profile_slug);
      required.push(...own);
      if (cfg.culling_profiles_filter_enabled) deciding.push(...own);
      return profileOutcome(profile, stages, answers, decisions);
    });
    const filtered = outcomes.find((o) => o.verdict === 'filtered');
    cullingProfileVerdict = filtered ? 'filtered' : outcomes.some((o) => o.verdict === null) ? null : 'passed';
    if (filtered && cfg.culling_profiles_filter_enabled) {
      filteredBy = 'culling_profile';
      filteredByStageKey = filtered.filteredStageKey;
    }
  }

  let scoreForecastP8: number | null = null;
  const sf = cfg.score_forecast;
  const forecastStage = stages.find((s) => s.kind === 'score_forecast');
  if (forecastStage && sf.enabled && opts.scoreForecastAvailable !== false) {
    required.push(forecastStage);
    deciding.push(forecastStage);
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

  const unanswered = (s: ResolvedStage) => !answers[s.stageKey];
  const pendingStages = required.filter(unanswered).map((s) => s.stageKey);
  const undecided = deciding.some(unanswered);
  const sentByHand = opts.sentByHand === true;
  const decision: PhotoDecision = {
    verdict: sentByHand ? 'passed' : filteredBy !== null ? 'filtered' : undecided ? 'pending' : 'passed',
    filteredBy: sentByHand ? null : filteredBy,
    filteredByStageKey: sentByHand ? null : filteredByStageKey,
    pendingStages,
    scoreForecastP8,
    sentByHandOverride: sentByHand && filteredBy !== null,
    cullingProfileVerdict,
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
 * The photo's summary: filtered by a profile while its filter is on (reported first), else filtered by
 * the Score forecast while it is on, else pending while a stage that filters is unanswered (pending never
 * passes), else passed. Sent by hand wins over all of it, across versions; the stage decisions still say
 * what the stages would have done.
 */
export function decidePhoto(
  cfg: PipelineSettingConfig,
  stages: readonly ResolvedStage[],
  answers: Readonly<Record<string, StageAnswers>>,
  opts: DecideOptions,
): PhotoDecision {
  return walk(cfg, stages, answers, opts).decision;
}
