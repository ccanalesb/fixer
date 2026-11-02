import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Suspense } from 'react'
import { render, screen, fireEvent, waitFor, within, cleanup, act } from '@testing-library/react'
import type { Job } from '../../../../types/job'
import { deleteMatching } from '../../../../data/cache'
import {
  IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL,
  IMAGE_DETAILS_GENERATE_DESCRIPTION,
  IMAGE_DETAILS_GENERATE_SCORES,
  IMAGE_DETAILS_PERSPECTIVE_ANALYSIS,
} from '../../../../constants/strings'
import { AiTab } from '../AiTab'

const mockCreate = vi.fn()
const mockGetDescription = vi.fn()
const mockGetDefaults = vi.fn()
const mockListPerspectives = vi.fn()
const mockGetCurrentScores = vi.fn()

vi.mock('../../../../services/api', () => ({
  JobsAPI: { create: (...args: unknown[]) => mockCreate(...args) },
  DescriptionsAPI: { get: (...args: unknown[]) => mockGetDescription(...args) },
  ProvidersAPI: { getDefaults: (...args: unknown[]) => mockGetDefaults(...args) },
  PerspectivesAPI: { list: (...args: unknown[]) => mockListPerspectives(...args) },
  ScoresAPI: {
    getCurrent: (...args: unknown[]) => mockGetCurrentScores(...args),
    getHistory: vi.fn().mockResolvedValue({ history: [] }),
  },
}))

vi.mock('../../../ui/ProviderModelSelect', () => ({
  ProviderModelSelect: () => null,
}))

let capturedOnJobUpdated: ((job: Job) => void) | undefined

vi.mock('../../../../hooks/useJobSocket', () => ({
  useJobSocket: (opts: { onJobUpdated?: (job: Job) => void }) => {
    capturedOnJobUpdated = opts.onJobUpdated
    return { connected: true, socket: null }
  },
}))

const KEY = 'photos/test.jpg'

const score = (value: number, rationale: string) => ({
  current: [
    {
      perspective_slug: 'street',
      score: value,
      rationale,
      model_used: 'score-model',
      prompt_version: 'v1',
      scored_at: '2026-01-01T00:00:00Z',
      is_current: true,
    },
  ],
})

function renderTab() {
  return render(
    <Suspense fallback={null}>
      <AiTab imageKey={KEY} />
    </Suspense>,
  )
}

/** Provider defaults reach state through an effect; let it commit before clicking. */
async function settleDefaults() {
  await waitFor(() => expect(mockGetDefaults).toHaveBeenCalled())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('AiTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    capturedOnJobUpdated = undefined
    mockGetDefaults.mockResolvedValue({ description: { provider: 'ollama', model: 'llava' } })
    mockListPerspectives.mockResolvedValue([{ slug: 'street', display_name: 'Street' }])
    mockGetDescription.mockResolvedValue({
      description: {
        summary: 'A quiet alley at dusk.',
        composition: { techniques: ['leading_lines'] },
        technical: { mood: 'moody' },
        subjects: ['alley'],
        perspectives: { street: { analysis: 'blob rationale', score: 9 } },
        best_perspective: 'street',
        model_used: 'test-model',
      },
    })
    mockGetCurrentScores.mockResolvedValue(score(7, 'Scores-table rationale'))
    mockCreate.mockResolvedValue({ id: 'job-1', type: 'single_score', status: 'running' })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the description and the perspective scores as separate blocks', async () => {
    renderTab()
    expect(await screen.findByRole('heading', { name: IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: IMAGE_DETAILS_PERSPECTIVE_ANALYSIS })).toBeInTheDocument()
    expect(await screen.findByText('A quiet alley at dusk.')).toBeInTheDocument()
    expect(screen.getByText(/moody/)).toBeInTheDocument()
  })

  it('sources perspective scores from image_scores, not the description blob', async () => {
    renderTab()
    await screen.findByText('Scores-table rationale')
    const block = screen.getByRole('heading', { name: IMAGE_DETAILS_PERSPECTIVE_ANALYSIS }).parentElement as HTMLElement
    expect(within(block).getByText('Street')).toBeInTheDocument()
    expect(within(block).getByText('7 / 10')).toBeInTheDocument()
    expect(screen.queryByText(/blob rationale/)).not.toBeInTheDocument()
  })

  it('keeps the regenerate buttons out of the blocks, in the action area', async () => {
    renderTab()
    await screen.findByText('Scores-table rationale')
    for (const name of [IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL, IMAGE_DETAILS_PERSPECTIVE_ANALYSIS]) {
      const block = screen.getByRole('heading', { name }).parentElement as HTMLElement
      expect(within(block).queryByRole('button', { name: /generate/i })).toBeNull()
    }
    expect(screen.getByRole('button', { name: IMAGE_DETAILS_GENERATE_DESCRIPTION(true) })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: IMAGE_DETAILS_GENERATE_SCORES(true) })).toBeInTheDocument()
  })

  it('regenerates the description without forcing a rescore', async () => {
    renderTab()
    await screen.findByText('A quiet alley at dusk.')
    await settleDefaults()
    fireEvent.click(screen.getByRole('button', { name: IMAGE_DETAILS_GENERATE_DESCRIPTION(true) }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('single_describe', {
        image_key: KEY,
        image_type: 'catalog',
        force: false,
        provider_id: 'ollama',
        provider_model: 'llava',
      }),
    )
  })

  it('fires single_score with force and shows the new scores when the job completes', async () => {
    mockGetCurrentScores
      .mockResolvedValueOnce(score(7, 'Initial rationale'))
      .mockResolvedValueOnce(score(9, 'Refreshed rationale'))
    renderTab()
    await screen.findByText('Initial rationale')
    await settleDefaults()

    fireEvent.click(screen.getByRole('button', { name: IMAGE_DETAILS_GENERATE_SCORES(true) }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith('single_score', {
        image_key: KEY,
        image_type: 'catalog',
        force: true,
        provider_id: 'ollama',
        provider_model: 'llava',
      }),
    )

    await act(async () => {
      capturedOnJobUpdated?.({ id: 'job-1', type: 'single_score', status: 'completed' } as Job)
    })
    expect(await screen.findByText('Refreshed rationale')).toBeInTheDocument()
  })
})
