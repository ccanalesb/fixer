import { Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { deleteMatching } from '../cache'
import { useQuery } from '../useQuery'
import { cullingChanged, cullingProfilesChanged, keys, stacksChanged } from '../keys'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function AllProbes({
  fetches,
}: {
  fetches: Record<(typeof PROBE_IDS)[number], () => Promise<unknown>>
}) {
  const summary = useQuery(keys.cull.summary(), fetches.summary)
  const photos = useQuery(keys.cull.photos('all', 1), fetches.photos)
  const detail = useQuery(keys.cull.detail('probe.jpg'), fetches.detail)
  const months = useQuery(keys.images.catalogMonths(), fetches.months)
  const list = useQuery(keys.images.catalogList({ limit: 50 }), fetches.list)
  const imageDetail = useQuery(keys.images.detail('catalog', 'probe.jpg', ''), fetches.imageDetail)
  const frame = useQuery(keys.frameSubstance('probe.jpg'), fetches.frame)
  const dashboard = useQuery(keys.dashboard(), fetches.dashboard)
  const mirror = useQuery(keys.identity.mirror(), fetches.mirror)
  const postNext = useQuery(keys.identity.postNext(null), fetches.postNext)
  return (
    <div>
      {String(summary)}
      {String(photos)}
      {String(detail)}
      {String(months)}
      {String(list)}
      {String(imageDetail)}
      {String(frame)}
      {String(dashboard)}
      {String(mirror)}
      {String(postNext)}
    </div>
  )
}

const PROBE_IDS = [
  'summary',
  'photos',
  'detail',
  'months',
  'list',
  'imageDetail',
  'frame',
  'dashboard',
  'mirror',
  'postNext',
] as const

beforeEach(() => {
  deleteMatching(() => true)
})

describe('cullingChanged', () => {
  it('refetches every query the group covers', async () => {
    const pending = Object.fromEntries(
      PROBE_IDS.map((id) => [id, deferred<unknown>()]),
    ) as Record<(typeof PROBE_IDS)[number], Deferred<unknown>>
    const callCounts = Object.fromEntries(PROBE_IDS.map((id) => [id, 0])) as Record<
      (typeof PROBE_IDS)[number],
      number
    >
    const fetches = Object.fromEntries(
      PROBE_IDS.map((id) => [
        id,
        () => {
          callCounts[id] += 1
          return pending[id].promise
        },
      ]),
    ) as Record<(typeof PROBE_IDS)[number], () => Promise<unknown>>

    render(
      <Suspense fallback={<div>loading</div>}>
        <AllProbes fetches={fetches} />
      </Suspense>,
    )
    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => {
      for (const id of PROBE_IDS) {
        pending[id].resolve(id)
        await pending[id].promise
      }
    })

    for (const id of PROBE_IDS) {
      expect(callCounts[id]).toBe(1)
      pending[id] = deferred<unknown>()
    }

    act(() => {
      cullingChanged()
    })

    await act(async () => {
      for (const id of PROBE_IDS) {
        pending[id].resolve(`${id}-2`)
        await pending[id].promise
      }
    })

    for (const id of PROBE_IDS) {
      expect(callCounts[id]).toBe(2)
    }
  })
})

function StacksProbes({
  fetches,
}: {
  fetches: Record<(typeof STACK_PROBE_IDS)[number], () => Promise<unknown>>
}) {
  const months = useQuery(keys.images.catalogMonths(), fetches.months)
  const list = useQuery(keys.images.catalogList({ limit: 50 }), fetches.list)
  const imageDetail = useQuery(keys.images.detail('catalog', 'probe.jpg', ''), fetches.imageDetail)
  const suggestions = useQuery(keys.stacks.suggestions(), fetches.suggestions)
  const dashboard = useQuery(keys.dashboard(), fetches.dashboard)
  const mirror = useQuery(keys.identity.mirror(), fetches.mirror)
  const postNext = useQuery(keys.identity.postNext(null), fetches.postNext)
  const stackMembers = useQuery(keys.images.stackMembers(42), fetches.stackMembers)
  return (
    <div>
      {String(months)}
      {String(list)}
      {String(imageDetail)}
      {String(suggestions)}
      {String(dashboard)}
      {String(mirror)}
      {String(postNext)}
      {String(stackMembers)}
    </div>
  )
}

const STACK_PROBE_IDS = [
  'months',
  'list',
  'imageDetail',
  'suggestions',
  'dashboard',
  'mirror',
  'postNext',
  'stackMembers',
] as const

describe('stacksChanged', () => {
  it('refetches every query the group covers', async () => {
    const pending = Object.fromEntries(
      STACK_PROBE_IDS.map((id) => [id, deferred<unknown>()]),
    ) as Record<(typeof STACK_PROBE_IDS)[number], Deferred<unknown>>
    const callCounts = Object.fromEntries(STACK_PROBE_IDS.map((id) => [id, 0])) as Record<
      (typeof STACK_PROBE_IDS)[number],
      number
    >
    const fetches = Object.fromEntries(
      STACK_PROBE_IDS.map((id) => [
        id,
        () => {
          callCounts[id] += 1
          return pending[id].promise
        },
      ]),
    ) as Record<(typeof STACK_PROBE_IDS)[number], () => Promise<unknown>>

    render(
      <Suspense fallback={<div>loading</div>}>
        <StacksProbes fetches={fetches} />
      </Suspense>,
    )
    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => {
      for (const id of STACK_PROBE_IDS) {
        pending[id].resolve(id)
        await pending[id].promise
      }
    })

    for (const id of STACK_PROBE_IDS) {
      expect(callCounts[id]).toBe(1)
      pending[id] = deferred<unknown>()
    }

    act(() => {
      stacksChanged()
    })

    await act(async () => {
      for (const id of STACK_PROBE_IDS) {
        pending[id].resolve(`${id}-2`)
        await pending[id].promise
      }
    })

    for (const id of STACK_PROBE_IDS) {
      expect(callCounts[id]).toBe(2)
    }
  })
})

function CullingProfilesProbes({
  fetches,
}: {
  fetches: Record<(typeof CULLING_PROFILES_PROBE_IDS)[number], () => Promise<unknown>>
}) {
  const list = useQuery(keys.cullingProfiles.list(), fetches.list)
  const detail = useQuery(keys.cullingProfiles.detail('probe-slug'), fetches.detail)
  const pipeline = useQuery(keys.cullingProfiles.pipeline(), fetches.pipeline)
  const questions = useQuery(keys.scoreForecastQuestions(), fetches.questions)
  return (
    <div>
      {String(list)}
      {String(detail)}
      {String(pipeline)}
      {String(questions)}
    </div>
  )
}

const CULLING_PROFILES_PROBE_IDS = ['list', 'detail', 'pipeline', 'questions'] as const

describe('cullingProfilesChanged', () => {
  it('refetches every query the group covers', async () => {
    const pending = Object.fromEntries(
      CULLING_PROFILES_PROBE_IDS.map((id) => [id, deferred<unknown>()]),
    ) as Record<(typeof CULLING_PROFILES_PROBE_IDS)[number], Deferred<unknown>>
    const callCounts = Object.fromEntries(CULLING_PROFILES_PROBE_IDS.map((id) => [id, 0])) as Record<
      (typeof CULLING_PROFILES_PROBE_IDS)[number],
      number
    >
    const fetches = Object.fromEntries(
      CULLING_PROFILES_PROBE_IDS.map((id) => [
        id,
        () => {
          callCounts[id] += 1
          return pending[id].promise
        },
      ]),
    ) as Record<(typeof CULLING_PROFILES_PROBE_IDS)[number], () => Promise<unknown>>

    render(
      <Suspense fallback={<div>loading</div>}>
        <CullingProfilesProbes fetches={fetches} />
      </Suspense>,
    )
    expect(screen.getByText('loading')).toBeInTheDocument()

    await act(async () => {
      for (const id of CULLING_PROFILES_PROBE_IDS) {
        pending[id].resolve(id)
        await pending[id].promise
      }
    })

    for (const id of CULLING_PROFILES_PROBE_IDS) {
      expect(callCounts[id]).toBe(1)
      pending[id] = deferred<unknown>()
    }

    act(() => {
      cullingProfilesChanged()
    })

    await act(async () => {
      for (const id of CULLING_PROFILES_PROBE_IDS) {
        pending[id].resolve(`${id}-2`)
        await pending[id].promise
      }
    })

    for (const id of CULLING_PROFILES_PROBE_IDS) {
      expect(callCounts[id]).toBe(2)
    }
  })
})
