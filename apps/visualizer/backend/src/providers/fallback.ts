/**
 * Try the selected provider, then cascade through the fallback order.
 *
 * The attempt list is wider than it looks: every vision model in the primary
 * provider (requested one first), then the first vision model from each fallback
 * provider. A local Ollama that has the model unloaded should not send the whole
 * batch to a paid API, and a paid API that is rate-limiting should not stall the
 * batch when a local model is available.
 */
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { openDb } from '../db/connection.js';
import { markModelImageRefused } from '../db/jobs/provider-models.js';
import {
  ImageRefusedError,
  InvalidRequestError,
  isRetryableError,
  ModelUnavailableError,
  ProviderConnectionError,
  ProviderError,
} from './errors.js';
import type { ProviderRegistry } from './registry.js';
import { providerDisplayName, providerReadsPhotos } from './usability.js';
import type { ProviderClient } from './vision-client.js';
import { CancelledRetryError, retryWithBackoff, type CancelCheck, type LogCallback } from './retry.js';

export const NO_PHOTO_PROVIDER_LEFT = 'No provider left that can read a photo';

/** `(client, model) -> () => Promise<result>` */
export type FnFactory<T> = (client: ProviderClient, model: string) => () => Promise<T>;

/** One uniform line when a provider attempt falls through. */
function logCascade(
  logCallback: LogCallback,
  operation: string,
  pid: string,
  mid: string,
  e: unknown,
  attempts: readonly [string, string][],
  index: number,
): void {
  if (!logCallback) return;
  const next = attempts[index + 1];
  const nextLabel = next ? `${next[0]}/${next[1]}` : 'none';
  if (e instanceof ImageRefusedError) {
    const reason = e.responseBody.replace(/\s+/g, ' ').slice(0, 120);
    logCallback(
      'warning',
      `[${operation}] ${pid}/${mid} doesn't take images (${reason}), fallback -> ${nextLabel}`,
    );
    return;
  }
  logCallback(
    'warning',
    `[${operation}] ${pid}/${mid} failed (${(e as Error).name}), fallback -> ${nextLabel}`,
  );
}

function persistImageRefusal(providerId: string, modelId: string, reason: string): void {
  if (!existsSync(config.VISUALIZER_DB)) return;
  const db = openDb(config.VISUALIZER_DB, { readonly: false, vec: false });
  try {
    markModelImageRefused(db, providerId, modelId, reason);
  } finally {
    db.close();
  }
}

export class FallbackDispatcher {
  private readonly registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  /**
   * Execute `fnFactory(client, model)` with retry and fallback.
   *
   * Returns the result along with the provider and model that actually served
   * it, which the caller records — the label written into `model_used` has to be
   * what ran, not what was asked for.
   */
  async callWithFallback<T>(
    opts: {
      operation: string;
      fnFactory: FnFactory<T>;
      providerId: string;
      model: string;
      logCallback?: LogCallback;
      cancelCheck?: CancelCheck;
    },
  ): Promise<{ result: T; providerId: string; model: string }> {
    const { attempts, emptyFallbacks } = await this.buildAttempts(opts.providerId, opts.model);
    if (attempts.length === 0) throw new ProviderError(NO_PHOTO_PROVIDER_LEFT);

    const logCallback = opts.logCallback ?? null;
    this.logWhenSkippingNamedProvider(opts.providerId, attempts, opts.operation, logCallback);
    const cancelCheck = opts.cancelCheck ?? null;
    let lastError: unknown = null;

    for (const [index, [pid, mid]] of attempts.entries()) {
      // Checked between providers: without it, a cancel during the primary
      // provider's retries would still drag the whole cascade through another
      // three or four rounds of backoff before the worker checked in again.
      if (cancelCheck !== null && cancelCheck()) {
        throw new CancelledRetryError('cancel requested before fallback attempt');
      }

      const client = this.registry.getClient(pid);
      const retryConfig = this.registry.getRetryConfig(pid);
      const fn = opts.fnFactory(client, mid);

      try {
        const result = await retryWithBackoff(fn, retryConfig, { logCallback, cancelCheck });
        return { result, providerId: pid, model: mid };
      } catch (e) {
        // A cancel is surfaced directly — it must not fall through to the next
        // provider, which would be doing work the user asked us to stop.
        if (e instanceof CancelledRetryError) throw e;

        if (e instanceof InvalidRequestError) throw e;

        if (e instanceof ImageRefusedError) {
          persistImageRefusal(pid, mid, e.responseBody);
          lastError = e;
          logCascade(logCallback, opts.operation, pid, mid, e, attempts, index);
          continue;
        }

        if (isRetryableError(e) || e instanceof ProviderConnectionError) {
          // `ProviderConnectionError` is not retryable — a refused connection is
          // permanent for that provider — but it IS provider-specific, so it
          // cascades. `AuthenticationError` and `InvalidRequestError` are global
          // and propagate instead.
          lastError = e;
          logCascade(logCallback, opts.operation, pid, mid, e, attempts, index);
          continue;
        }
        throw e;
      }
    }

    // Exhausted. A fallback provider advertising no vision models is the
    // *actionable* failure — the user can configure one — so it wins over
    // whatever transient error the last working provider happened to throw.
    if (emptyFallbacks.length > 0) {
      throw new ModelUnavailableError(
        `No models available for fallback provider(s): ${emptyFallbacks.join(', ')}`,
      );
    }
    throw lastError;
  }

  /**
   * The ordered `(provider, model)` attempts, plus the fallback providers that
   * turned out to have no vision models.
   */
  private logWhenSkippingNamedProvider(
    namedId: string,
    attempts: readonly [string, string][],
    operation: string,
    logCallback: LogCallback | null,
  ): void {
    if (!namedId || !logCallback || attempts.length === 0) return;
    const usingId = attempts[0]![0];
    if (usingId === namedId) return;

    const usingName = providerDisplayName(this.registry, usingId);
    if (!this.registry.hasProvider(namedId)) {
      logCallback('warning', `[${operation}] ${namedId} was removed; using ${usingName}`);
      return;
    }
    if (!this.registry.isEnabled(namedId)) {
      const named = providerDisplayName(this.registry, namedId);
      logCallback('warning', `[${operation}] ${named} is parked; using ${usingName}`);
    }
  }

  private async buildAttempts(
    primaryId: string,
    primaryModel: string,
  ): Promise<{ attempts: [string, string][]; emptyFallbacks: string[] }> {
    const availableIds = new Set<string>();
    for (const p of await this.registry.listProviders()) {
      if (!p.available || !this.registry.isCascadeEligible(p.id)) continue;
      if (await providerReadsPhotos(this.registry, p.id)) availableIds.add(p.id);
    }

    const attempts: [string, string][] = [];
    const emptyFallbacks: string[] = [];

    if (availableIds.has(primaryId)) {
      const listed = await this.registry.listModels(primaryId);
      const byId = new Map(listed.map((m) => [m.id, m]));
      const visionModels = listed.filter((m) => m.vision !== false).map((m) => m.id);
      const listedPrimary = byId.get(primaryModel);
      const primaryAccepts =
        listedPrimary === undefined || listedPrimary.vision !== false;
      // The requested model goes first when it is unknown or still accepts images.
      const ordered = [
        ...(primaryAccepts ? [primaryModel] : []),
        ...visionModels.filter((m) => m !== primaryModel),
      ];
      for (const mid of ordered) attempts.push([primaryId, mid]);
    }

    for (const pid of this.registry.fallbackOrder) {
      if (pid === primaryId || !availableIds.has(pid)) continue;
      const visionModels = (await this.registry.listModels(pid))
        .filter((m) => m.vision !== false)
        .map((m) => m.id);
      if (visionModels.length > 0) attempts.push([pid, visionModels[0]!]);
      else emptyFallbacks.push(pid);
    }

    return { attempts, emptyFallbacks };
  }
}
