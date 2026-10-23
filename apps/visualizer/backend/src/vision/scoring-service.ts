/**
 * Score catalog images per perspective into `image_scores`.
 *
 * The describe twin of this module writes one row per image; this one writes one
 * row per image *and rubric version*, which is why so much of it is bookkeeping.
 * A perspective's markdown is editable, and a score means nothing without knowing
 * which wording produced it — so the rubric is hashed into `prompt_version`, and
 * a score is only "already done" when the hash still matches.
 */
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { buildScoreOpSpec } from '../analyzer/scoring.js';
import { buildScoringUserPrompt } from '../analyzer/prompt-builder.js';
import type { Db } from '../db/connection.js';
import { getImage } from '../db/library/catalog.js';
import { isPhotoFilteredAndNotSentByHand } from '../db/library/cull-verdicts.js';
import {
  getFrameSubstanceVerdict,
  hasFrameSubstanceOverride,
} from '../db/library/frame-substance.js';
import {
  deleteScoresForVersion,
  getPerspectiveBySlug,
  insertImageScore,
  perspectiveScoreAlreadyCurrent,
  supersedePreviousCurrentScores,
  type PerspectiveRow,
} from '../db/library/scores.js';
import { clearStaleScore, isScoreStale } from '../db/library/vision-stale.js';
import { libraryWrite } from '../db/library/write.js';
import { VIDEO_EXTENSIONS } from '../imaging/raw-decode.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CancelCheck, LogCallback } from '../providers/retry.js';
import { nowIsoUtcSeconds } from '../utils/datetime.js';
import { resolveFilepath } from '../utils/path-resolve.js';
import { StructuredOutputError } from './structured-output.js';
import { resolveVisionImage } from './vision-cache.js';
import { runVisionOpPersist, VisionOpOutcome } from './vision-op.js';

/** Stable rubric id: `{slug}:{sha256(prompt_markdown)[:16]}`. See D-23. */
export function computePromptVersion(row: Pick<PerspectiveRow, 'slug' | 'prompt_markdown'>): string {
  const digest = createHash('sha256')
    .update(row.prompt_markdown ?? '', 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${String(row.slug)}:${digest}`;
}

/** Strip a trailing parenthetical and case-fold, to compare the model's echoed slug. */
function normalizePerspectiveSlug(rawSlug: string): string {
  return rawSlug
    .trim()
    .replace(/\s*\(.*\)\s*$/, '')
    .toLowerCase()
    .trim();
}

export interface ScoreOptions {
  imageType?: string;
  force?: boolean;
  providerId?: string | null;
  model?: string | null;
  logCallback?: LogCallback;
  registry?: ProviderRegistry | null;
  cancelCheck?: CancelCheck;
}

/** Why a photo culling filtered was not scored. */
export const CULL_FILTERED_SCORE_SKIP_REASON = 'Culling verdict: filtered (send it by hand to score it)';

/**
 * Score one image for one perspective.
 *
 * `wrote` is true only when a new `image_scores` row was written; every other
 * outcome leaves the table untouched.
 */
export async function scoreImageForPerspective(
  db: Db,
  imageKey: string,
  perspectiveSlug: string,
  opts: ScoreOptions = {},
): Promise<VisionOpOutcome> {
  const imageType = opts.imageType ?? 'catalog';
  // A score made from a since-turned cache image is replaced like a forced one.
  const force = Boolean(opts.force) || isScoreStale(db, imageKey, perspectiveSlug);

  if (imageType !== 'catalog') {
    return new VisionOpOutcome('failed', `Invalid image_type: '${imageType}'`);
  }

  const image = getImage(db, imageKey);
  const rawPath = image?.['filepath'];
  if (!image || typeof rawPath !== 'string' || !rawPath) {
    return new VisionOpOutcome('skipped', 'Catalog image missing or has no filepath');
  }
  // Existence is settled later by `resolveVisionImage`, so an unreachable NAS
  // still scores off the local cache.
  const filepath = resolveFilepath(rawPath);

  if (VIDEO_EXTENSIONS.has(extname(filepath).toLowerCase())) {
    return new VisionOpOutcome('skipped', `Video file not scorable: ${basename(filepath)}`);
  }

  // A frame the detector called void has no content to judge. Scoring it anyway
  // would put a number on an empty frame and let it compete in the ranking — an
  // explicit human override is the only thing that reinstates it.
  const substance = getFrameSubstanceVerdict(db, imageKey);
  if (substance?.verdict === 'void' && !hasFrameSubstanceOverride(db, imageKey)) {
    return new VisionOpOutcome('skipped', 'Frame substance verdict: void');
  }
  // Culling filtered it and the user did not send it on. Only a filtered photo is refused: a pending or
  // never-culled photo is held back by the batch jobs, not here.
  if (isPhotoFilteredAndNotSentByHand(db, imageKey)) {
    return new VisionOpOutcome('skipped', CULL_FILTERED_SCORE_SKIP_REASON);
  }

  const perspective = getPerspectiveBySlug(db, perspectiveSlug);
  if (!perspective) {
    return new VisionOpOutcome('failed', `Unknown perspective slug: '${perspectiveSlug}'`);
  }
  if (Number(perspective.active ?? 0) !== 1) {
    return new VisionOpOutcome('failed', `Perspective '${perspectiveSlug}' is not active`);
  }

  const promptVersion = computePromptVersion(perspective);

  if (!force && perspectiveScoreAlreadyCurrent(db, imageKey, imageType, perspectiveSlug, promptVersion)) {
    return new VisionOpOutcome(
      'skipped',
      'Score already current for this image, perspective, and prompt version',
    );
  }

  const { path: imageForScore, silentCompression } = await resolveVisionImage(db, imageKey, filepath);
  if (imageForScore === null) {
    return new VisionOpOutcome('skipped', `Image file not found: ${filepath}`);
  }

  const spec = buildScoreOpSpec(imageForScore, {
    userPrompt: buildScoringUserPrompt(perspective),
    providerId: opts.providerId ?? null,
    model: opts.model ?? null,
    logCallback: opts.logCallback ?? null,
    silentCompression,
    registry: opts.registry ?? null,
    cancelCheck: opts.cancelCheck ?? null,
  });
  try {
    const outcome = await runVisionOpPersist(spec, {
      acceptResult: ({ parsed }) => {
        // The score is persisted under the *requested* perspective whatever the
        // model echoes back: a display name that diverges from its slug makes
        // some models paraphrase it, and discarding a valid score over that would
        // cost a provider call to gain nothing. The mismatch is logged instead.
        const got = normalizePerspectiveSlug(parsed.perspective_slug);
        if (got !== perspectiveSlug.trim() && opts.logCallback) {
          opts.logCallback(
            'warning',
            `Slug mismatch: model returned '${parsed.perspective_slug}', normalized to ` +
              `'${got}', expected '${perspectiveSlug}' — persisting under '${perspectiveSlug}'`,
          );
        }
        return true;
      },
      persist: ({ parsed, repaired }, provider, modelUsed) => {
        const scoredAt = nowIsoUtcSeconds();
        libraryWrite(
          db,
          () => {
            if (force) {
              deleteScoresForVersion(db, imageKey, imageType, perspectiveSlug, promptVersion);
            }
            supersedePreviousCurrentScores(db, imageKey, imageType, perspectiveSlug, promptVersion);
            insertImageScore(db, {
              image_key: imageKey,
              image_type: imageType,
              perspective_slug: perspectiveSlug,
              score: parsed.score,
              rationale: parsed.rationale,
              model_used: `${provider}:${modelUsed}`,
              prompt_version: promptVersion,
              scored_at: scoredAt,
              is_current: 1,
              repaired_from_malformed: repaired ? 1 : 0,
              not_attempted: parsed.not_attempted ? 1 : 0,
            });
            clearStaleScore(db, imageKey, perspectiveSlug);
          },
          { log: opts.logCallback ?? undefined },
        );
      },
    });

    if (outcome.status === 'failed' && outcome.reason === 'invalid result') {
      return new VisionOpOutcome('failed', 'model returned empty or invalid score response');
    }
    return outcome;
  } catch (e) {
    if (e instanceof StructuredOutputError) {
      return new VisionOpOutcome('failed', e.describe());
    }
    const message = e instanceof Error ? e.message : String(e);
    // Two workers can pick the same image and perspective; the unique index is
    // what settles it, and the loser has nothing to report but "already done".
    if (message.includes('UNIQUE constraint')) {
      return new VisionOpOutcome('skipped', 'Score already written by concurrent worker');
    }
    return new VisionOpOutcome('failed', message);
  }
}
