/**
 * Describe catalog images on demand.
 */
import { extname } from 'node:path';
import { getDescriptionModel } from '../config.js';
import { buildDescriptionOpSpec, type DescriptionStructured } from '../analyzer/description.js';
import { VIDEO_EXTENSIONS } from '../imaging/raw-decode.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CancelCheck, LogCallback } from '../providers/retry.js';
import { buildDescriptionUserPrompt } from '../analyzer/prompt-builder.js';
import { getImage } from '../db/library/catalog.js';
import { isPhotoFilteredAndNotSentByHand } from '../db/library/cull-verdicts.js';
import { getFrameSubstanceVerdict, hasFrameSubstanceOverride } from '../db/library/frame-substance.js';
import { getImageDescription, storeImageDescription } from '../db/library/descriptions.js';
import { clearStaleDescription, isDescriptionStale } from '../db/library/vision-stale.js';
import { libraryWrite } from '../db/library/write.js';
import type { Db } from '../db/connection.js';
import { resolveFilepath } from '../utils/path-resolve.js';
import { resolveVisionImage } from './vision-cache.js';
import { runVisionOpPersist, VisionOpOutcome } from './vision-op.js';

/** Counters for a batch describe pass. */
export interface DescribeTelemetry {
  silentCompressionSkips: number;
}

/**
 * Extensions the vision pipeline cannot describe, short-circuited before
 * compression or dispatch.
 *
 * Without this a `.mov` falls all the way through to the LLM — `compressImage`
 * silently returns the original path when it cannot decode — and then stalls the
 * worker on multi-minute retry backoffs, which wedges the whole batch.
 */
const NON_DESCRIBABLE_EXTENSIONS = VIDEO_EXTENSIONS;

function isNonDescribablePath(filepath: string | null | undefined): boolean {
  if (!filepath) return false;
  return NON_DESCRIBABLE_EXTENSIONS.has(extname(filepath).toLowerCase());
}

/**
 * True when the op's output is worth storing.
 *
 * A blank summary is indistinguishable from a real description in the UI, and
 * storing one would stop the image ever being retried — so an empty answer must
 * fail rather than persist.
 */
export function descriptionStructuredIsValid(structured: DescriptionStructured): boolean {
  const summary = structured.summary;
  return typeof summary === 'string' && summary.trim().length > 0;
}

/**
 * Normalize the model's loose output into the columns `image_descriptions` holds.
 *
 * Models answer the prompt's root-level `dominant_colors` / `mood_tags` /
 * `has_repetition` fields inconsistently, and the same values are also asked for
 * inside `technical`:
 *
 *   - `dominant_colors`: root list if non-empty, else `technical.dominant_colors`.
 *     An empty root list falls through, because "the model returned []" and "the
 *     model omitted it" mean the same thing for indexing.
 *   - `mood_tags`: root list if it *is* a list — including `[]`, which is taken as
 *     a deliberate "no tags" and does not fall through — else `[technical.mood]`.
 *   - `has_repetition`: passed through untouched, including non-boolean junk, and
 *     coerced by `storeImageDescription`.
 */
export function storeStructured(
  db: Db,
  imageKey: string,
  imageType: string,
  structured: DescriptionStructured,
  modelUsed: string | null = null,
): void {
  const rawTechnical = structured.technical;
  const technical: Record<string, unknown> =
    rawTechnical !== null && typeof rawTechnical === 'object' && !Array.isArray(rawTechnical)
      ? (rawTechnical as Record<string, unknown>)
      : {};

  const rawDc = structured.dominant_colors;
  let dc: unknown[] | null;
  if (Array.isArray(rawDc) && rawDc.length > 0) {
    dc = rawDc;
  } else {
    const tc = technical.dominant_colors;
    dc = Array.isArray(tc) ? tc : null;
  }

  const rawMt = structured.mood_tags;
  let mt: unknown[] | null = Array.isArray(rawMt) ? rawMt : null;
  if (mt === null) {
    const mood = technical.mood;
    if (typeof mood === 'string' && mood.trim()) mt = [mood.trim()];
  }

  const hr = structured.has_repetition ?? null;

  libraryWrite(db, () => {
    storeImageDescription(db, {
      image_key: imageKey,
      image_type: imageType,
      summary: typeof structured.summary === 'string' ? structured.summary : '',
      composition: structured.composition ?? {},
      technical: structured.technical ?? {},
      subjects: structured.subjects ?? [],
      model_used: modelUsed || getDescriptionModel(),
      dominant_colors: dc,
      mood_tags: mt,
      has_repetition: hr,
    });
    clearStaleDescription(db, imageKey);
  });
}

export interface DescribeOptions {
  force?: boolean;
  providerId?: string | null;
  model?: string | null;
  logCallback?: LogCallback;
  registry?: ProviderRegistry | null;
  cancelCheck?: CancelCheck;
  telemetry?: DescribeTelemetry | null;
}

/** Why a photo is not described whatever `force` says: a void frame, or a filtered photo nobody sent on. */
export function describeRefusal(db: Db, catalogKey: string): string | null {
  const substance = getFrameSubstanceVerdict(db, catalogKey);
  if (substance?.verdict === 'void' && !hasFrameSubstanceOverride(db, catalogKey)) {
    return 'Frame substance verdict: void';
  }
  if (isPhotoFilteredAndNotSentByHand(db, catalogKey)) return 'Culling verdict: filtered (send it by hand to describe it)';
  return null;
}

/**
 * Generate and store a description for one catalog image.
 *
 * `wrote` is true only when a non-empty description was stored; skipped and
 * failed outcomes leave the database untouched.
 */
export async function describeMatchedImage(
  db: Db,
  catalogKey: string,
  opts: DescribeOptions = {},
): Promise<VisionOpOutcome> {
  if (!opts.force && getImageDescription(db, catalogKey) && !isDescriptionStale(db, catalogKey)) {
    return new VisionOpOutcome('skipped', 'description exists');
  }

  const image = getImage(db, catalogKey);
  const rawPath = image?.['filepath'];
  if (!image || typeof rawPath !== 'string' || !rawPath) {
    return new VisionOpOutcome('skipped', 'image not found');
  }

  const filepath = resolveFilepath(rawPath);
  if (isNonDescribablePath(filepath)) {
    return new VisionOpOutcome('skipped', 'non-describable file type');
  }

  // The same two checks scoring makes (#339): a void frame has nothing to describe, and a photo the
  // filtered photo is described only once the user sends it on.
  const refused = describeRefusal(db, catalogKey);
  if (refused !== null) return new VisionOpOutcome('skipped', refused);

  // Prefer the local vision cache: the original may be unreachable — an unmounted
  // NAS is the normal case — and describe can still run off the cached JPEG.
  const { path: imageForDescribe, silentCompression } = await resolveVisionImage(
    db,
    catalogKey,
    filepath,
  );
  if (imageForDescribe === null) {
    return new VisionOpOutcome('skipped', 'file missing');
  }

  const spec = buildDescriptionOpSpec(imageForDescribe, {
    providerId: opts.providerId ?? null,
    model: opts.model ?? null,
    logCallback: opts.logCallback ?? null,
    userPrompt: buildDescriptionUserPrompt(),
    silentCompression,
    registry: opts.registry ?? null,
    cancelCheck: opts.cancelCheck ?? null,
  });
  const outcome = await runVisionOpPersist(spec, {
    acceptResult: descriptionStructuredIsValid,
    persist: (structured, provider, modelUsed) => {
      // `provider:model` is what the UI shows and what `desc_model` is filtered
      // on, so the provider half is included whenever it is known.
      const resolvedModel = modelUsed || opts.model || getDescriptionModel();
      const label = provider ? `${provider}:${resolvedModel}` : resolvedModel;
      storeStructured(db, catalogKey, 'catalog', structured, label);
    },
  });

  if (silentCompression && opts.telemetry) {
    opts.telemetry.silentCompressionSkips += 1;
  }
  return outcome;
}
