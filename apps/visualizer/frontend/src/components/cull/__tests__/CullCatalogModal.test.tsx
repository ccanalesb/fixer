import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import {
  CullAPI,
  DescriptionsAPI,
  FrameSubstanceAPI,
  ImagesAPI,
  PerspectivesAPI,
  ProvidersAPI,
  ScoresAPI,
  type ImageDetailResponse,
} from '../../../services/api'
import { ImageDetailModal } from '../../image-view/ImageDetailModal'
import {
  CULL_AGREE,
  CULL_SENT_BY_HAND_NOTE,
  CULL_PASSED,
  CULL_SCORE_FORECAST,
  SCORE_FORECAST_DOES_NOT_APPLY,
  CULL_PASS_HINT,
  CULL_PASS_NO,
  CULL_PASS_QUESTION,
  CULL_PASS_YES,
} from '../../../constants/strings'
import { deleteMatching } from '../../../data/cache'

const KEY = 'passed-one'

const DETAIL = {
  image_type: 'catalog',
  key: KEY,
  filename: 'passed-one.jpg',
  rating: 3,
  identity_aggregate_score: null,
  identity_perspectives_covered: 0,
  identity_eligible: false,
  identity_per_perspective: [],
  ai_analyzed: false,
  description_summary: null,
} as ImageDetailResponse

describe('Cull catalog modal cull section', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.spyOn(ImagesAPI, 'getImageDetail').mockResolvedValue(DETAIL)
    vi.spyOn(CullAPI, 'photoDetail')
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
      image_key: KEY,
      has_detection_run: false,
      verdict: null,
      unknown_reason: null,
      detector_version: null,
      judged_at: null,
      is_stale: false,
      has_override: false,
      flagged: false,
      has_cull_keyword: null,
      instrument: null,
      restore_tier: null,
      catalog_write_available: true,
      catalog_write_unavailable_reason: null,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('asks whether culling got a passed photo right', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
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

    render(
      <ImageDetailModal
        imageType="catalog"
        imageKey={KEY}
        primaryScoreSource="catalog"
        showCullSection
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByText(CULL_PASS_QUESTION)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: CULL_PASS_YES })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: CULL_PASS_NO })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(CULL_PASS_HINT)).toBeInTheDocument()
  })

  it('shows why a passed photo passed: profile answers and score forecast', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'passed',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: true,
      score_forecast: [
        { name: 'Natural framing device', p8: 0.1704, excused: false },
        { name: 'Clean composition', p8: 0.0208, excused: false },
        { name: 'Framing', p8: null, excused: true },
      ],
      profile: {
        slug: 'default',
        name: 'Default culling profile',
        level_sets: [
          {
            id: '10',
            dimensions: [
              { slug: 'impact', name: 'Immediate impact', levels: [{ level: 10, fails: false, strong: true }] },
              { slug: 'structure', name: 'Visual structure', levels: [{ level: 1, fails: true, strong: false }] },
            ],
          },
        ],
      },
      user_actions: [],
      filtered_by: null,
      score_forecast_p8: 0.1704,
    })

    render(
      <ImageDetailModal
        imageType="catalog"
        imageKey={KEY}
        primaryScoreSource="catalog"
        showCullSection
        onClose={() => {}}
      />,
    )

    await waitFor(() => expect(screen.getByText(CULL_PASSED)).toBeInTheDocument())
    expect(screen.getByText('Default culling profile')).toBeInTheDocument()
    expect(screen.getByText('10 levels')).toBeInTheDocument()
    expect(screen.getByText('Immediate impact')).toBeInTheDocument()
    expect(screen.getByText(CULL_SCORE_FORECAST)).toBeInTheDocument()
    expect(screen.getByText('17.0%')).toBeInTheDocument()
    expect(screen.getByText('2.1%')).toBeInTheDocument()
    expect(screen.getByText('Framing').parentElement).toHaveTextContent(SCORE_FORECAST_DOES_NOT_APPLY)
    expect(screen.getByText('17.0%').parentElement).toHaveClass('font-semibold')
    expect(screen.getByRole('button', { name: CULL_PASS_NO })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CULL_AGREE })).not.toBeInTheDocument()
  })

  it('shows No selected once the user said so; Yes withdraws it', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'passed',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: false,
      score_forecast: [],
      profile: { slug: '', name: '', level_sets: [] },
      user_actions: [{ action: 'should_have_been_filtered', acted_at: '2026-01-01T00:00:00Z' }],
      filtered_by: null,
      score_forecast_p8: null,
    })

    render(
      <ImageDetailModal
        imageType="catalog"
        imageKey={KEY}
        primaryScoreSource="catalog"
        showCullSection
        onClose={() => {}}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: CULL_PASS_NO })).toHaveAttribute('aria-pressed', 'true'),
    )
    expect(screen.getByRole('button', { name: CULL_PASS_YES })).toHaveAttribute('aria-pressed', 'false')

    const withdraw = vi.spyOn(CullAPI, 'withdrawShouldHaveBeenFiltered').mockResolvedValue({ ok: true, removed: 1 })
    fireEvent.click(screen.getByRole('button', { name: CULL_PASS_YES }))
    await waitFor(() => expect(withdraw).toHaveBeenCalledWith(KEY))
  })

  it('shows the sent-by-hand note for manually sent photos', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'passed',
      sent_by_hand: true,
      completion: 'none',
      needs_send_work: false,
      score_forecast: [],
      profile: { slug: '', name: '', level_sets: [] },
      user_actions: [{ action: 'sent_by_hand', acted_at: '2026-01-01T00:00:00Z' }],
      filtered_by: null,
      score_forecast_p8: null,
    })

    render(
      <ImageDetailModal
        imageType="catalog"
        imageKey={KEY}
        primaryScoreSource="catalog"
        showCullSection
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(CULL_SENT_BY_HAND_NOTE)).toBeInTheDocument()
      expect(CULL_SENT_BY_HAND_NOTE).toBe('Sent by hand — never filtered automatically again.')
    })
  })
})
