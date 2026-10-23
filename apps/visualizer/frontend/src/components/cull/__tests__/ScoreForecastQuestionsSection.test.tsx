import { Suspense } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ScoreForecastQuestionsSection } from '../ScoreForecastQuestionsSection'
import { deleteMatching } from '../../../data/cache'
import {
  ApiRequestError,
  ScoreForecastQuestionsAPI,
  type ScoreForecastQuestion,
  type ScoreForecastQuestionsResponse,
} from '../../../services/api'
import {
  CULL_PROFILE_TEXT_SAVE_IMPACT,
  CULL_SAVE_AND_QUEUE,
  CULL_SAVE_ONLY,
  SCORE_FORECAST_QUESTIONS_ID,
  SFQ_ADD,
  SFQ_APPLIES,
  SFQ_LEVEL,
  SFQ_NAME,
  SFQ_NEW_NAME,
  SFQ_OPTIONAL,
  SFQ_PERSPECTIVE,
  SFQ_QUESTION,
  SFQ_REMOVE,
  SFQ_SECTION,
  SFQ_SUMMARY,
  SFQ_TAB_LEVELS,
} from '../../../constants/strings'

const levels = (tag: string) => Array.from({ length: 10 }, (_, i) => `${i + 1} of 10 — ${tag}`)
const FRAMING: ScoreForecastQuestion = {
  id: 'framing',
  name: 'Framing',
  perspective_slug: 'framing',
  instructions: 'How well does a framing device enclose the subject?',
  levels: levels('framing'),
  optional: true,
  applies: 'Does "Framing" apply to this photo?',
}
const CLEAN: ScoreForecastQuestion = {
  id: 'compositional-cleanliness',
  name: 'Compositional Cleanliness',
  perspective_slug: 'compositional-cleanliness',
  instructions: 'How clean is the composition?',
  levels: levels('clean'),
  optional: false,
  applies: null,
}

let current: ScoreForecastQuestionsResponse
const impact = { photos: 120, hours_estimate: 0.07 }

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  deleteMatching(() => true)
  window.location.hash = ''
  current = {
    questions: [FRAMING, CLEAN],
    version: 3,
    perspectives: [
      { slug: 'framing', name: 'Framing', active: true },
      { slug: 'compositional-cleanliness', name: 'Compositional Cleanliness', active: true },
      { slug: 'street', name: 'Street', active: true },
    ],
  }
  vi.spyOn(ScoreForecastQuestionsAPI, 'get').mockImplementation(async () => current)
  vi.spyOn(ScoreForecastQuestionsAPI, 'save').mockImplementation(async (questions) => {
    current = { ...current, questions, version: current.version + 1 }
    return { ...current, created: true, impact, cull_job_id: null }
  })
})

const renderSection = () =>
  render(
    <Suspense fallback={null}>
      <ScoreForecastQuestionsSection />
    </Suspense>,
  )

async function openSection() {
  renderSection()
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(SFQ_SECTION) }))
}

const savedQuestions = () => vi.mocked(ScoreForecastQuestionsAPI.save).mock.calls[0]![0]

describe('ScoreForecastQuestionsSection', () => {
  it('folds to how many questions there are, how many ask whether they apply, and the version', async () => {
    renderSection()
    expect(await screen.findByText(SFQ_SUMMARY(2, 1, 3))).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('a link to it opens it', async () => {
    window.location.hash = `#${SCORE_FORECAST_QUESTIONS_ID}`
    const { container } = renderSection()
    expect(await screen.findByRole('textbox', { name: `${SFQ_QUESTION} · Framing` })).toBeInTheDocument()
    expect(container.querySelector(`#${SCORE_FORECAST_QUESTIONS_ID}`)).not.toBeNull()
  })

  it('shows each question with its perspective, its text and, when optional, its "applies?" text', async () => {
    await openSection()
    expect(await screen.findByRole('combobox', { name: `${SFQ_PERSPECTIVE} · Framing` })).toHaveValue('framing')
    expect(screen.getByRole('textbox', { name: `${SFQ_QUESTION} · Framing` })).toHaveValue(FRAMING.instructions)
    expect(screen.getByRole('textbox', { name: `${SFQ_APPLIES} · Framing` })).toHaveValue(FRAMING.applies)
    expect(screen.queryByRole('textbox', { name: `${SFQ_APPLIES} · Compositional Cleanliness` })).not.toBeInTheDocument()
  })

  it('saves nothing until something changes; Save only sends the whole set and says what it costs', async () => {
    await openSection()
    const question = await screen.findByRole('textbox', { name: `${SFQ_QUESTION} · Framing` })
    expect(screen.getByRole('button', { name: CULL_SAVE_ONLY })).toBeDisabled()
    fireEvent.change(question, { target: { value: 'Is there a frame?' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    await waitFor(() => expect(ScoreForecastQuestionsAPI.save).toHaveBeenCalledTimes(1))
    expect(vi.mocked(ScoreForecastQuestionsAPI.save).mock.calls[0]![1]).toBe('save_only')
    expect(savedQuestions()).toEqual([{ ...FRAMING, instructions: 'Is there a frame?' }, CLEAN])
    expect(await screen.findByText(CULL_PROFILE_TEXT_SAVE_IMPACT(120, 0.07))).toBeInTheDocument()
    expect(screen.getByText(SFQ_SUMMARY(2, 1, 4))).toBeInTheDocument()
  })

  it('Save and queue culling saves in that mode', async () => {
    await openSection()
    fireEvent.click((await screen.findAllByRole('button', { name: SFQ_REMOVE }))[0]!)
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_AND_QUEUE }))
    await waitFor(() => expect(ScoreForecastQuestionsAPI.save).toHaveBeenCalledTimes(1))
    expect(vi.mocked(ScoreForecastQuestionsAPI.save).mock.calls[0]![1]).toBe('save_and_queue_cull')
    expect(savedQuestions()).toEqual([CLEAN])
  })

  it('turning optional off sends no "applies?" text', async () => {
    await openSection()
    const framing = (await screen.findByRole('textbox', { name: `${SFQ_QUESTION} · Framing` })).parentElement!
    fireEvent.click(within(framing).getByRole('checkbox', { name: SFQ_OPTIONAL }))
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    await waitFor(() => expect(ScoreForecastQuestionsAPI.save).toHaveBeenCalledTimes(1))
    expect(savedQuestions()[0]).toEqual({ ...FRAMING, optional: false, applies: null })
  })

  it('a new question takes its id from its perspective, and its 10 levels are written in Levels', async () => {
    await openSection()
    fireEvent.click(await screen.findByRole('button', { name: SFQ_ADD }))
    const names = screen.getAllByRole('textbox', { name: SFQ_NAME })
    expect(names[2]).toHaveValue(SFQ_NEW_NAME)
    fireEvent.change(names[2]!, { target: { value: 'Street' } })
    fireEvent.change(screen.getByRole('combobox', { name: `${SFQ_PERSPECTIVE} · Street` }), { target: { value: 'street' } })
    fireEvent.change(screen.getByRole('textbox', { name: `${SFQ_QUESTION} · Street` }), {
      target: { value: 'How much street moment?' },
    })
    fireEvent.click(screen.getByRole('tab', { name: SFQ_TAB_LEVELS }))
    fireEvent.click(screen.getByRole('button', { name: /Street/ }))
    for (let i = 1; i <= 10; i++) {
      fireEvent.change(screen.getByRole('textbox', { name: SFQ_LEVEL(i, 'Street') }), { target: { value: `street ${i}` } })
    }
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    await waitFor(() => expect(ScoreForecastQuestionsAPI.save).toHaveBeenCalledTimes(1))
    expect(savedQuestions()[2]).toEqual({
      id: 'street',
      name: 'Street',
      perspective_slug: 'street',
      instructions: 'How much street moment?',
      levels: Array.from({ length: 10 }, (_, i) => `street ${i + 1}`),
      optional: false,
      applies: null,
    })
  })

  it('a new question with no perspective takes its id from its name, never one already used', async () => {
    current = { ...current, questions: [{ ...CLEAN, id: 'my-question', name: 'Mine', perspective_slug: null }] }
    await openSection()
    fireEvent.click(await screen.findByRole('button', { name: SFQ_ADD }))
    fireEvent.change(screen.getAllByRole('textbox', { name: SFQ_NAME })[1]!, { target: { value: 'My question' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    await waitFor(() => expect(ScoreForecastQuestionsAPI.save).toHaveBeenCalledTimes(1))
    expect(savedQuestions()[1]!.id).toBe('my-question-2')
  })

  it('what the server refuses is shown under the question it is about', async () => {
    vi.mocked(ScoreForecastQuestionsAPI.save).mockRejectedValueOnce(
      new ApiRequestError('Invalid Score forecast questions', [
        { field: 'framing.applies', message: 'An optional question needs its "applies?" text' },
      ]),
    )
    await openSection()
    fireEvent.change(await screen.findByRole('textbox', { name: `${SFQ_APPLIES} · Framing` }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: CULL_SAVE_ONLY }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('An optional question needs its "applies?" text')
    expect(alert.parentElement).toContainElement(screen.getByRole('textbox', { name: `${SFQ_APPLIES} · Framing` }))
  })

  it('Levels shows the chosen question’s 10 levels, lowest first, and how many are empty', async () => {
    await openSection()
    fireEvent.click(await screen.findByRole('button', { name: SFQ_ADD }))
    fireEvent.click(screen.getByRole('tab', { name: SFQ_TAB_LEVELS }))
    expect(screen.getByRole('textbox', { name: SFQ_LEVEL(1, SFQ_NEW_NAME) })).toHaveValue('')
    expect(screen.getByRole('button', { name: new RegExp(`^${SFQ_NEW_NAME}\\s*10$`) })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Framing' }))
    expect(screen.getByRole('textbox', { name: SFQ_LEVEL(1, 'Framing') })).toHaveValue('1 of 10 — framing')
    expect(screen.getByRole('textbox', { name: SFQ_LEVEL(10, 'Framing') })).toHaveValue('10 of 10 — framing')
  })
})
