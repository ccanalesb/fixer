/**
 * Whether a provider can serve vision jobs (describe, score, analyze).
 *
 * Usable means cascade-eligible (enabled, OpenAI-compatible, resolvable auth)
 * and at least one model that still accepts images — not marked as refusing them.
 */
import type { ProviderRegistry } from './registry.js';

export async function providerReadsPhotos(
  registry: ProviderRegistry,
  providerId: string,
): Promise<boolean> {
  if (!registry.isCascadeEligible(providerId)) return false;
  const models = await registry.listModels(providerId);
  return models.some((m) => m.vision !== false && !m.image_refused_reason);
}

/** First provider in fallback order that can read a photo, optionally skipping one id. */
export async function firstPhotoProvider(
  registry: ProviderRegistry,
  opts: { skipId?: string } = {},
): Promise<string | null> {
  const skip = opts.skipId;
  for (const pid of registry.fallbackOrder) {
    if (skip && pid === skip) continue;
    if (await providerReadsPhotos(registry, pid)) return pid;
  }
  if (skip) {
    for (const pid of registry.providerIds) {
      if (pid === skip || registry.fallbackOrder.includes(pid)) continue;
      if (await providerReadsPhotos(registry, pid)) return pid;
    }
  }
  return null;
}

export function providerDisplayName(registry: ProviderRegistry, providerId: string): string {
  return registry.providerConfig(providerId)?.name ?? providerId;
}
