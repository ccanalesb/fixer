/**
 * The vision operation engine — one provider call plus a persist stage.
 *
 * The shape exists so that "resolve a model, dispatch with fallback, parse the
 * answer" is written once. Describe and score differ only in their prompt, their
 * parser and what they store; every retry, cascade and cancellation rule is
 * shared, which is the only way those rules stay consistent between them.
 */
import { FallbackDispatcher, type FnFactory } from '../providers/fallback.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { resolveModel, type Kind } from '../providers/resolution.js';
import type { CancelCheck, LogCallback } from '../providers/retry.js';

export type VisionOpStatus = 'written' | 'skipped' | 'failed';

export class VisionOpOutcome {
  readonly status: VisionOpStatus;
  readonly reason: string | null;

  constructor(status: VisionOpStatus, reason: string | null = null) {
    this.status = status;
    this.reason = reason;
  }

  get wrote(): boolean {
    return this.status === 'written';
  }
}

export interface VisionOpSpec<TParsed> {
  resolveKind: Kind;
  /** Log label — `"describe"` or `"score"`. */
  operation: string;
  providerId: string | null;
  model: string | null;
  /**
   * Builds the `(client, model) -> call` factory.
   *
   * Called once per op, not once per attempt, so per-op setup — RAW conversion
   * and compression — happens a single time no matter how far the cascade runs.
   */
  fnFactory: () => Promise<FnFactory<string>>;
  /**
   * Parse the raw text.
   *
   * Receives the provider and model that actually served the call, because the
   * scoring parser uses them to build an LLM repair call against the same model.
   */
  parseResponse: (raw: string, provider: string, model: string) => TParsed | Promise<TParsed>;
  logCallback?: LogCallback;
  registry?: ProviderRegistry | null;
  allowNamedProviderFallback?: boolean;
  cancelCheck?: CancelCheck;
  /** Always runs, so temp files are removed even when the cascade throws. */
  cleanup?: (() => void | Promise<void>) | null;
}

/** Run one vision op: resolve → dispatch with fallback → parse. */
export async function runVisionOp<TParsed>(
  spec: VisionOpSpec<TParsed>,
): Promise<{ parsed: TParsed; provider: string; model: string }> {
  let registry: ProviderRegistry;
  let providerId: string;
  let model: string;

  if (spec.registry) {
    // A caller that already resolved (the batch handlers do, once per run)
    // passes its registry so this does not re-read providers.json per image.
    registry = spec.registry;
    providerId = spec.providerId ?? '';
    model = spec.model ?? '';
  } else {
    const resolved = await resolveModel({
      kind: spec.resolveKind,
      providerId: spec.providerId,
      model: spec.model,
      allowNamedProviderFallback: spec.allowNamedProviderFallback,
    });
    ({ registry, providerId, model } = resolved);
  }

  const dispatcher = new FallbackDispatcher(registry);
  try {
    const fnFactory = await spec.fnFactory();
    const { result, providerId: actualProvider, model: actualModel } =
      await dispatcher.callWithFallback({
        operation: spec.operation,
        fnFactory,
        providerId,
        model,
        logCallback: spec.logCallback ?? null,
        cancelCheck: spec.cancelCheck ?? null,
      });
    const parsed = await spec.parseResponse(result, actualProvider, actualModel);
    return { parsed, provider: actualProvider, model: actualModel };
  } finally {
    await spec.cleanup?.();
  }
}

/**
 * Pre-check → run → persist, reporting an outcome without swallowing exceptions.
 *
 * `acceptResult` is the gate that stops an empty or malformed answer being
 * stored: a description row with a blank summary looks identical to a real one in
 * the UI, and would stop the image being retried.
 */
export async function runVisionOpPersist<TParsed>(
  spec: VisionOpSpec<TParsed>,
  hooks: {
    preCheck?: (() => VisionOpOutcome | null) | null;
    acceptResult: (parsed: TParsed) => boolean;
    persist: (parsed: TParsed, provider: string, model: string) => void | Promise<void>;
  },
): Promise<VisionOpOutcome> {
  const early = hooks.preCheck?.();
  if (early) return early;

  const { parsed, provider, model } = await runVisionOp(spec);
  if (!hooks.acceptResult(parsed)) {
    return new VisionOpOutcome('failed', 'invalid result');
  }
  await hooks.persist(parsed, provider, model);
  return new VisionOpOutcome('written');
}
