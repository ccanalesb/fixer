/**
 * A new cull run on photos the research runs answered, with the same image, gives the same verdicts
 * (#338). Reads the research files and the images they name; never `library.db`.
 *
 * Needs the exported models and the research files, so it skips unless LT_LAYA_PARITY=1:
 *
 *   LT_LAYA_PARITY=1 npx vitest run tests/cull-parity.test.ts
 *
 * LT_CULL_RESEARCH_DIR points at the research bench (default ~/lightroom-research/bench);
 * LT_CULL_PARITY_PHOTOS sets how many photos to answer (default 6, about 2.5 s each).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, loadLibraryConfig } from '../src/config.js';
import { decidePhoto } from '../src/cull/decide.js';
import { DEFAULT_SCORE_FORECAST } from '../src/cull/default-pipeline.js';
import type { PipelineSettingConfig, ResolvedStage, StageAnswers } from '../src/cull/types.js';
import { startLayaWithCheck } from '../src/laya/runtime.js';
import { LAYA_QUESTIONS } from '../src/laya/questions.js';

const bench = process.env.LT_CULL_RESEARCH_DIR ?? join(homedir(), 'lightroom-research', 'bench');
const profileFile = join(bench, 'laya-gate', 'laya_cull_catalog_all.jsonl');
const layaNewFile = join(bench, 'distill', 'outputs', 'laya_new_catalog.jsonl');
const modelsDir = loadLibraryConfig(config.LT_CONFIG_YAML).layaModelsDir;
const enabled =
  process.env.LT_LAYA_PARITY === '1' &&
  existsSync(join(modelsDir, 'laya-new')) &&
  existsSync(profileFile) &&
  existsSync(layaNewFile);
const describeMaybe = enabled ? describe : describe.skip;
const PHOTOS = Number(process.env.LT_CULL_PARITY_PHOTOS ?? 6);

const DIMS = ['immediate-impact', 'visual-structure', 'point-of-tension', 'connotation'];
const PIPELINE: PipelineSettingConfig = {
  culling_profiles_enabled: true,
  culling_profiles_filter_enabled: true,
  culling_profiles: [
    {
      profile_slug: 'recipe-culling',
      rule: {
        level_sets: { '7': { fails_at_most: 3, strong_at_least: 6 }, '10': { fails_at_most: 4, strong_at_least: 8 } },
        combine: 'every',
        filter_rule: { type: 'all_fail', dimensions: ['point-of-tension', 'connotation'] },
      },
    },
  ],
  score_forecast: DEFAULT_SCORE_FORECAST,
};
const stage = (stageKey: string, kind: ResolvedStage['kind'], levelSet: string | null): ResolvedStage => ({
  stageKey,
  kind,
  versionId: 0,
  model: kind === 'score_forecast' ? 'new' : 'base',
  modelId: '',
  profileSlug: levelSet ? 'recipe-culling' : null,
  levelSet,
  questions: {},
});

interface Research {
  key: string;
  image: string;
  profile: Record<string, number[]>;
  layaNew: StageAnswers;
}

/** The first photos whose research image is still there and unchanged since the run. */
function sample(): Research[] {
  const profileMtime = statSync(profileFile).mtimeMs;
  const profile = new Map<string, { image: string; answers: Record<string, number[]> }>();
  for (const line of readFileSync(profileFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: { key: string; image: string; answers: Record<string, { probabilities: number[] }> };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const p = profile.get(r.key) ?? { image: r.image, answers: {} };
    for (const [q, a] of Object.entries(r.answers)) p.answers[q] = a.probabilities;
    profile.set(r.key, p);
  }
  const out: Research[] = [];
  for (const line of readFileSync(layaNewFile, 'utf8').split('\n')) {
    if (out.length >= PHOTOS || !line.trim()) break;
    const n = JSON.parse(line) as { key: string; image: string; rows: { slug: string; probs: number[]; p_excused?: number }[] };
    const r = profile.get(n.key);
    if (!r || r.image !== n.image || !existsSync(n.image) || statSync(n.image).mtimeMs > profileMtime) continue;
    const layaNew: StageAnswers = Object.fromEntries(n.rows.map((row) => [row.slug, row.probs]));
    const pExcused = n.rows.find((row) => row.slug === 'framing')?.p_excused ?? 0;
    layaNew['framing-excusal'] = [pExcused, 1 - pExcused];
    out.push({ key: n.key, image: n.image, profile: r.answers, layaNew });
  }
  return out;
}

function stageAnswers(profile: Record<string, number[]>, layaNew: StageAnswers | null) {
  const answers: Record<string, StageAnswers> = {};
  const stages: ResolvedStage[] = [];
  for (const set of ['7', '10']) {
    if (!DIMS.every((d) => profile[`${set}|${d}`])) continue;
    const key = `culling_profile:recipe-culling:${set}`;
    stages.push(stage(key, 'culling_profile', set));
    answers[key] = Object.fromEntries(DIMS.map((d) => [d, profile[`${set}|${d}`]!]));
  }
  if (layaNew) {
    stages.push(stage('score_forecast', 'score_forecast', null));
    answers.score_forecast = layaNew;
  }
  return { stages, answers };
}

describeMaybe('a new cull run agrees with the research runs', () => {
  it('same verdict per stage and per photo, probabilities close', { timeout: 600_000 }, async () => {
    const photos = sample();
    expect(photos.length).toBeGreaterThan(0);
    const { runtime } = await startLayaWithCheck(modelsDir);
    try {
      for (const p of photos) {
        const { answers } = await runtime.answer(p.image);
        const research = stageAnswers(p.profile, p.layaNew);
        const fresh = stageAnswers(
          Object.fromEntries(Object.keys(p.profile).map((q) => [q, answers.base[q]!])),
          Object.fromEntries(Object.keys(LAYA_QUESTIONS.new).map((q) => [q, answers.new![q]!])),
        );
        for (const [q, probs] of Object.entries(p.profile)) {
          answers.base[q]!.forEach((v, i) => expect(Math.abs(v - probs[i]!), `${p.key} ${q}`).toBeLessThan(0.02));
        }
        const a = decidePhoto(PIPELINE, research.stages, research.answers, {});
        const b = decidePhoto(PIPELINE, fresh.stages, fresh.answers, {});
        expect({ key: p.key, verdict: b.verdict, filteredBy: b.filteredBy }).toEqual({ key: p.key, verdict: a.verdict, filteredBy: a.filteredBy });
        for (const s of Object.keys(a.stages)) expect(b.stages[s]!.verdict, `${p.key} ${s}`).toBe(a.stages[s]!.verdict);
      }
    } finally {
      await runtime.close();
    }
  });
});
