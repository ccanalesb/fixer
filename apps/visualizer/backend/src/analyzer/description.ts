/**
 * The structured description pipeline.
 */
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { compressImage, getViewablePathManaged } from '../imaging/image-prep.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CancelCheck, LogCallback } from '../providers/retry.js';
import { generateDescription } from '../providers/vision-client.js';
import type { VisionOpSpec } from '../vision/vision-op.js';
import { buildDescriptionUserPrompt } from './prompt-builder.js';

/** Fallback prompt when no user prompt is supplied. */
export function buildDescriptionPrompt(): string {
  return buildDescriptionUserPrompt();
}

export type DescriptionStructured = Record<string, unknown>;

const DESCRIPTION_FALLBACK: DescriptionStructured = {
  summary: '',
  dominant_colors: [],
  mood_tags: [],
  has_repetition: false,
  composition: {},
  technical: {},
  subjects: [],
};

/**
 * Parse a model response into a structured description.
 *
 * Three attempts, in order, because models disobey "respond with ONLY this JSON"
 * in exactly these three ways: a clean object, an object wrapped in a markdown
 * fence, and an object with commentary around it. The empty fallback is returned
 * rather than throwing so the caller's `acceptResult` gate rejects it — which
 * keeps a blank summary out of the database while still letting the image be
 * retried later.
 */
export function parseDescriptionResponse(raw: string): DescriptionStructured {
  let text = raw.trim();

  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fenceMatch) text = fenceMatch[1]!.trim();

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DescriptionStructured;
    }
  } catch {
    // Fall through to the brace scan.
  }

  const braceMatch = /\{[\s\S]*\}/.exec(text);
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch[0]) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as DescriptionStructured;
      }
    } catch {
      // Give up and return the fallback.
    }
  }

  return { ...DESCRIPTION_FALLBACK };
}

export interface DescriptionOpOptions {
  providerId?: string | null;
  model?: string | null;
  logCallback?: LogCallback;
  userPrompt?: string | null;
  /** The path is an already-compressed cache file; do not recompress it. */
  silentCompression?: boolean;
  registry?: ProviderRegistry | null;
  allowNamedProviderFallback?: boolean;
  think?: boolean;
  maxTokens?: number;
  cancelCheck?: CancelCheck;
}

/**
 * Build the spec for the description vision op.
 *
 * The RAW conversion and compression happen inside `fnFactory`, which the engine
 * calls once per op rather than once per attempt — so a cascade across four
 * providers re-sends the same JPEG instead of re-decoding the RAW four times, and
 * `cleanup` removes the temp files however the op ends.
 */
export function buildDescriptionOpSpec(
  path: string,
  opts: DescriptionOpOptions = {},
): VisionOpSpec<DescriptionStructured> {
  const tempFiles: string[] = [];

  return {
    resolveKind: 'description',
    operation: 'describe',
    providerId: opts.providerId ?? null,
    model: opts.model ?? null,
    logCallback: opts.logCallback ?? null,
    registry: opts.registry ?? null,
    allowNamedProviderFallback: opts.allowNamedProviderFallback ?? false,
    cancelCheck: opts.cancelCheck ?? null,
    parseResponse: (raw) => parseDescriptionResponse(raw),
    fnFactory: async () => {
      const viewable = await getViewablePathManaged(path);
      if (viewable.isTemp) tempFiles.push(viewable.path);

      // A vision-cache hit is already a compressed JPEG; re-compressing it on a
      // restart or resume only adds CPU work and noisy output.
      let compressed = viewable.path;
      if (!opts.silentCompression) {
        compressed = await compressImage(viewable.path);
        if (compressed !== viewable.path) tempFiles.push(compressed);
      }

      return (client, mdl) => async () =>
        generateDescription(client, mdl, compressed, {
          logCallback: opts.logCallback ?? null,
          userPrompt: opts.userPrompt ?? null,
          think: opts.think ?? false,
          maxTokens: opts.maxTokens ?? 2048,
          fallbackPrompt: buildDescriptionPrompt(),
        });
    },
    cleanup: async () => {
      for (const f of tempFiles) {
        if (existsSync(f)) await unlink(f).catch(() => undefined);
      }
    },
  };
}
