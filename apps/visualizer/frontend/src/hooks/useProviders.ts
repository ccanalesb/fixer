import { useCallback } from 'react'
import { keys, providersChanged, useQuery } from '../data'
import { ProvidersAPI, type Provider, type ProviderModel } from '../services/api'

const EMPTY_PROVIDER_BUNDLE: { providers: Provider[]; fallbackOrder: string[] } = {
  providers: [],
  fallbackOrder: [],
}

async function fetchProviderBundle(): Promise<{
  providers: Provider[]
  fallbackOrder: string[]
}> {
  const [providerList, fallback] = await Promise.all([
    ProvidersAPI.list(),
    ProvidersAPI.getFallbackOrder(),
  ])
  return { providers: providerList, fallbackOrder: fallback.order }
}

export function useProviders() {
  const bundle = useQuery(keys.providers.hookBundle(), fetchProviderBundle, {
    initialValue: EMPTY_PROVIDER_BUNDLE,
  })

  const refresh = useCallback(() => {
    providersChanged()
  }, [])

  const updateFallbackOrder = useCallback(async (order: string[]) => {
    await ProvidersAPI.updateFallbackOrder(order)
  }, [])

  return {
    providers: bundle.providers,
    fallbackOrder: bundle.fallbackOrder,
    loading: false,
    error: null,
    refresh,
    updateFallbackOrder,
  }
}

export function useProviderModels(providerId: string | null) {
  const models = useQuery(
    keys.providers.models(providerId),
    async (): Promise<ProviderModel[]> => {
      if (!providerId) return []
      return ProvidersAPI.listModels(providerId)
    },
    { initialValue: [] },
  )

  return { models, loading: false, error: null }
}
