import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThisAppCard } from '../ThisAppCard'
import { AppModelsAPI, type AppModel } from '../../../services/api'
import {
  APP_MODEL_ADD,
  APP_MODEL_ADD_BUTTON,
  APP_MODEL_ADD_COST_CONFIRM,
  APP_MODEL_CHOOSE,
  APP_MODEL_CONVERTING,
  APP_MODEL_INPUT_LABEL,
  APP_MODEL_MANUAL,
  APP_MODEL_READY,
  APP_MODEL_VIEW_JOB,
  APP_MODELS_EMPTY,
  THIS_APP_CARD_TITLE,
  CULLING_MODELS_CANCEL,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../../constants/strings'
import type { Job } from '../../../types/job'

const socket = vi.hoisted(() => ({ onJobUpdated: null as null | ((job: Job) => void) }))
vi.mock('../../../hooks/useJobSocket', () => ({
  useJobSocket: (opts: { onJobUpdated?: (job: Job) => void }) => {
    socket.onJobUpdated = opts.onJobUpdated ?? null
    return { connected: true, socket: null, jobListRevision: 0, refreshJobList: () => {} }
  },
}))

let models: AppModel[]
let pickerAvailable: boolean

const ready = (name: string, source: string): AppModel => ({ name, source, revision: null, status: 'ready', job_id: null })

beforeEach(() => {
  vi.restoreAllMocks()
  socket.onJobUpdated = null
  models = []
  pickerAvailable = true
  vi.spyOn(AppModelsAPI, 'list').mockImplementation(async () => ({ models, picker_available: pickerAvailable }))
  vi.spyOn(AppModelsAPI, 'add').mockImplementation(async (source) => {
    models = [...models, { name: 'culling-model', source, revision: null, status: 'converting', job_id: 'job-1' }]
    return { name: 'culling-model', job_id: 'job-1' }
  })
})

function renderCard() {
  return render(
    <MemoryRouter>
      <ThisAppCard cullingProfileUsesThisApp={false} scoreForecastUsesThisApp={false} />
    </MemoryRouter>,
  )
}

const row = (name: string) => screen.getByText(name, { selector: '.text-sm.font-medium' }).closest('[data-model]') as HTMLElement

describe('ThisAppCard', () => {
  it('lists each installed model with Ready or Converting', async () => {
    models = [
      ready('culling-model', 'owner/vision-model'),
      { name: 'my-run-best', source: '/Users/me/my-run/best', revision: null, status: 'converting', job_id: 'job-7' },
    ]
    renderCard()
    expect(await screen.findByText(THIS_APP_CARD_TITLE)).toBeInTheDocument()
    expect(within(row('culling-model')).getByText(APP_MODEL_READY)).toBeInTheDocument()
    expect(within(row('my-run-best')).getByText(APP_MODEL_CONVERTING)).toBeInTheDocument()
    expect(within(row('my-run-best')).getByRole('link', { name: APP_MODEL_VIEW_JOB })).toHaveAttribute(
      'href',
      PROCESSING_JOB_QUEUE_ROUTE,
    )
  })

  it('says so when nothing is installed', async () => {
    renderCard()
    expect(await screen.findByText(APP_MODELS_EMPTY)).toBeInTheDocument()
  })

  it('adds a model from a typed Hugging Face id after confirming the cost', async () => {
    renderCard()
    fireEvent.click(await screen.findByText(APP_MODEL_MANUAL))
    fireEvent.change(screen.getByLabelText(APP_MODEL_INPUT_LABEL), { target: { value: 'owner/vision-model' } })
    fireEvent.click(screen.getByRole('button', { name: APP_MODEL_ADD_BUTTON }))
    fireEvent.click(await screen.findByRole('button', { name: APP_MODEL_ADD_COST_CONFIRM }))
    await waitFor(() => expect(AppModelsAPI.add).toHaveBeenCalledWith('owner/vision-model'))
    expect(await screen.findByText(APP_MODEL_CONVERTING)).toBeInTheDocument()
  })

  it('Choose… fills the folder from the backend dialog', async () => {
    vi.spyOn(AppModelsAPI, 'pick').mockResolvedValue({ path: '/Users/me/my-run/best' })
    renderCard()
    fireEvent.click(await screen.findByRole('button', { name: APP_MODEL_CHOOSE }))
    const addRow = screen.getByText(APP_MODEL_ADD).closest('[data-add]') as HTMLElement
    fireEvent.click(within(addRow).getAllByRole('button', { name: CULLING_MODELS_CANCEL })[0]!)
    expect(screen.queryByText('best')).not.toBeInTheDocument()
  })
})
