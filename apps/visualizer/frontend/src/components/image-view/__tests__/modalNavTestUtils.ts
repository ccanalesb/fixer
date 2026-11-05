import { fireEvent, screen, waitFor } from '@testing-library/react'
import { vi, expect } from 'vitest'
import type { ImageDetailResponse } from '../../../services/api'
import {
  CullAPI,
  DescriptionsAPI,
  FrameSubstanceAPI,
  ImagesAPI,
  PerspectivesAPI,
  ProvidersAPI,
  ScoresAPI,
} from '../../../services/api'
import { CULL_MODAL_NEXT, CULL_MODAL_PREV } from '../../../constants/strings'

export function mockImageDetailFilenames(keys: string[]) {
  const byKey = Object.fromEntries(keys.map((key) => [key, `${key}.jpg`]))
  vi.spyOn(ImagesAPI, 'getImageDetail').mockImplementation(async (_type, key: string) =>
    ({
      image_type: 'catalog',
      key,
      filename: byKey[key] ?? `${key}.jpg`,
      rating: 3,
      identity_aggregate_score: null,
      identity_perspectives_covered: 0,
      identity_eligible: false,
      identity_per_perspective: [],
      ai_analyzed: false,
      description_summary: null,
    }) as ImageDetailResponse,
  )
}

export function mockImageDetailModalDeps() {
  vi.spyOn(ProvidersAPI, 'getDefaults').mockResolvedValue({
    description: { provider: null, model: null },
  } as unknown as Awaited<ReturnType<typeof ProvidersAPI.getDefaults>>)
  vi.spyOn(PerspectivesAPI, 'list').mockResolvedValue([])
  vi.spyOn(ScoresAPI, 'getCurrent').mockResolvedValue({
    current: [],
  } as unknown as Awaited<ReturnType<typeof ScoresAPI.getCurrent>>)
  vi.spyOn(ScoresAPI, 'getHistory').mockResolvedValue({
    history: [],
  } as unknown as Awaited<ReturnType<typeof ScoresAPI.getHistory>>)
  vi.spyOn(DescriptionsAPI, 'get').mockResolvedValue({ description: null } as Awaited<
    ReturnType<typeof DescriptionsAPI.get>
  >)
  vi.spyOn(FrameSubstanceAPI, 'get').mockResolvedValue({
    image_key: 'k',
    has_detection_run: false,
    verdict: null,
    unknown_reason: null,
    detector_version: null,
    judged_at: null,
    is_stale: false,
    has_override: false,
    flagged: false,
    instrument: null,
    restore_tier: null,
  })
  vi.spyOn(CullAPI, 'photoDetail').mockResolvedValue({
    image_key: 'k',
    filename: 'k.jpg',
    verdict: 'passed',
    sent_by_hand: false,
    completion: 'none',
    needs_send_work: false,
    score_forecast: [],
    profile: { slug: '', name: '', level_sets: [] },
    user_actions: [],
    filtered_by: null,
    score_forecast_p8: null,
  })
}

export async function expectModalFilename(name: string) {
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 2, name: new RegExp(name) })).toBeInTheDocument(),
  )
}

export function clickModalNav(direction: 'prev' | 'next') {
  const label = direction === 'next' ? CULL_MODAL_NEXT : CULL_MODAL_PREV
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }))
}

export function clickTileByKey(imageKey: string) {
  const tile = document.querySelector(`[data-image-key="${imageKey}"]`)
  const button = tile?.querySelector('button')
  if (!button) throw new Error(`no tile button for ${imageKey}`)
  fireEvent.click(button)
}

export async function stepModalPrevNext(firstFile: string, secondFile: string, thirdFile: string) {
  await expectModalFilename(secondFile)
  clickModalNav('next')
  await expectModalFilename(thirdFile)
  clickModalNav('prev')
  clickModalNav('prev')
  await expectModalFilename(firstFile)
  expect(screen.getByRole('button', { name: new RegExp(CULL_MODAL_PREV) })).toBeDisabled()
}
