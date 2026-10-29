import type { Provider, ProviderModel } from '../../services/api';

/** A model that can still be sent a photo for describe/score. */
export function modelReadsPhotos(model: ProviderModel): boolean {
  return model.vision !== false && !model.image_refused_reason;
}

export function providerReadsPhotos(provider: Provider, models: ProviderModel[]): boolean {
  if (!provider.enabled || !provider.available) return false;
  return models.some(modelReadsPhotos);
}

/** Next provider in fallback order that can read a photo, skipping one id. */
export function nextPhotoProvider(
  providers: Provider[],
  fallbackOrder: string[],
  modelCache: Record<string, ProviderModel[]>,
  skipId?: string,
): Provider | null {
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  for (const id of fallbackOrder) {
    if (skipId && id === skipId) continue;
    const p = byId[id];
    if (!p) continue;
    const models = modelCache[id] ?? [];
    if (providerReadsPhotos(p, models)) return p;
  }
  for (const p of providers) {
    if ((skipId && p.id === skipId) || fallbackOrder.includes(p.id)) continue;
    const models = modelCache[p.id] ?? [];
    if (providerReadsPhotos(p, models)) return p;
  }
  return null;
}

export function anyPhotoProvider(
  providers: Provider[],
  fallbackOrder: string[],
  modelCache: Record<string, ProviderModel[]>,
): boolean {
  return nextPhotoProvider(providers, fallbackOrder, modelCache) !== null;
}
