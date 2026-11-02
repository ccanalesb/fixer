import { useEffect, useReducer, useRef } from 'react'
import { onDelete } from './cache'
import { query } from './query'

type UseQueryOptions<T> = {
  /** Optional first-render value to avoid initial Suspense for non-critical data. */
  initialValue?: T
}

export function useQuery<T>(
  key: readonly unknown[],
  fetcher: () => Promise<T>,
  options?: UseQueryOptions<T>,
): T {
  const [, forceRender] = useReducer((n: number) => n + 1, 0)
  const lastValueRef = useRef<T | undefined>(options?.initialValue)
  const pendingPromiseRef = useRef<Promise<unknown> | null>(null)
  const unmountedRef = useRef(false)

  if (lastValueRef.current === undefined && options?.initialValue !== undefined) {
    lastValueRef.current = options.initialValue
  }

  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  const cacheKey = JSON.stringify(key)
  useEffect(() => onDelete((k) => k === cacheKey && forceRender()), [cacheKey])

  try {
    const value = query(key, fetcher)
    lastValueRef.current = value
    pendingPromiseRef.current = null
    return value
  } catch (thrown) {
    if (thrown instanceof Promise && lastValueRef.current !== undefined) {
      if (pendingPromiseRef.current !== thrown) {
        pendingPromiseRef.current = thrown
        void thrown.finally(() => {
          if (pendingPromiseRef.current === thrown) {
            pendingPromiseRef.current = null
          }
          if (!unmountedRef.current) {
            forceRender()
          }
        })
      }
      return lastValueRef.current
    }
    throw thrown
  }
}
