import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
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
  CULL_MANUALLY_CULL_NOTE,
  CULL_PASSED,
  CULL_SCORE_FORECAST,
  CULL_SHOULD_HAVE_BEEN_CUT,
  CULL_SHOULD_HAVE_BEEN_CUT_MARKED,
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

  it('shows Should have been cut for passed photos', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'sent',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: false,
      score_forecast: [],
      recipe: { slug: '', name: '', level_sets: [] },
      user_actions: [],
      cut_by: null,
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
      expect(screen.getByRole('button', { name: CULL_SHOULD_HAVE_BEEN_CUT })).toBeInTheDocument()
    })
  })

  it('shows why a passed photo passed: recipe answers and score forecast', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'sent',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: true,
      score_forecast: [
        { name: 'Natural framing device', p8: 0.1704 },
        { name: 'Clean composition', p8: 0.0208 },
      ],
      recipe: {
        slug: 'recipe-7h47',
        name: 'Recipe 7H47',
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
      cut_by: null,
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
    expect(screen.getByText('Recipe 7H47')).toBeInTheDocument()
    expect(screen.getByText('10 levels')).toBeInTheDocument()
    expect(screen.getByText('Immediate impact')).toBeInTheDocument()
    expect(screen.getByText(CULL_SCORE_FORECAST)).toBeInTheDocument()
    expect(screen.getByText('17.0%')).toBeInTheDocument()
    expect(screen.getByText('2.1%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CULL_SHOULD_HAVE_BEEN_CUT })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CULL_AGREE })).not.toBeInTheDocument()
  })

  it('marks Should have been cut once the user said so', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'sent',
      sent_by_hand: false,
      completion: 'none',
      needs_send_work: false,
      score_forecast: [],
      recipe: { slug: '', name: '', level_sets: [] },
      user_actions: [{ action: 'should_have_been_cut', acted_at: '2026-01-01T00:00:00Z' }],
      cut_by: null,
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
      expect(screen.getByRole('button', { name: CULL_SHOULD_HAVE_BEEN_CUT_MARKED })).toBeDisabled(),
    )
  })

  it('shows the sent-by-hand note for manually sent photos', async () => {
    vi.mocked(CullAPI.photoDetail).mockResolvedValue({
      image_key: KEY,
      filename: 'passed-one.jpg',
      verdict: 'sent',
      sent_by_hand: true,
      completion: 'none',
      needs_send_work: false,
      score_forecast: [],
      recipe: { slug: '', name: '', level_sets: [] },
      user_actions: [{ action: 'sent_by_hand', acted_at: '2026-01-01T00:00:00Z' }],
      cut_by: null,
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
      expect(screen.getByText(CULL_MANUALLY_CULL_NOTE)).toBeInTheDocument()
    })
  })
})
