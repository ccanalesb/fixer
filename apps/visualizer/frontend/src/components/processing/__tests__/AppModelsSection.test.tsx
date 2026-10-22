import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppModelsSection } from '../AppModelsSection'
import { AppModelsAPI, type AppModel } from '../../../services/api'
import {
  APP_MODEL_ADD,
  APP_MODEL_ADD_BUTTON,
  APP_MODEL_ADD_HINT,
  APP_MODEL_CHOOSE,
  APP_MODEL_CONVERTING,
  APP_MODEL_INPUT_LABEL,
  APP_MODEL_MANUAL,
  APP_MODEL_READY,
  APP_MODEL_VIEW_JOB,
  APP_MODELS_EMPTY,
  APP_MODELS_SECTION,
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
    models = [...models, { name: 'laya-base', source, revision: null, status: 'converting', job_id: 'job-1' }]
    return { name: 'laya-base', job_id: 'job-1' }
  })
})

function renderSection() {
  return render(
    <MemoryRouter>
      <AppModelsSection />
    </MemoryRouter>,
  )
}

const row = (name: string) => screen.getByText(name, { selector: '.text-sm.font-medium' }).closest('[data-model]') as HTMLElement

describe('AppModelsSection', () => {
  it('lists each installed model with its source, and a converting one with its job', async () => {
    models = [
      ready('laya-base', 'thaitea/laya-vision'),
      { name: 'laya-run-best', source: '/Users/me/laya-run/best', revision: null, status: 'converting', job_id: 'job-7' },
    ]
    renderSection()
    expect(await screen.findByText(APP_MODELS_SECTION)).toBeInTheDocument()
    await screen.findByText('laya-run-best')
    expect(within(row('laya-base')).getByText('thaitea/laya-vision')).toBeInTheDocument()
    expect(within(row('laya-base')).getByText(APP_MODEL_READY)).toBeInTheDocument()
    expect(within(row('laya-run-best')).getByText(APP_MODEL_CONVERTING)).toBeInTheDocument()
    expect(within(row('laya-run-best')).getByRole('link', { name: APP_MODEL_VIEW_JOB })).toHaveAttribute(
      'href',
      PROCESSING_JOB_QUEUE_ROUTE,
    )
  })

  it('says so when nothing is installed', async () => {
    renderSection()
    expect(await screen.findByText(APP_MODELS_EMPTY)).toBeInTheDocument()
  })

  it('adds a Hugging Face id typed by hand, which then lists as converting', async () => {
    renderSection()
    fireEvent.click(await screen.findByText(APP_MODEL_MANUAL))
    const input = screen.getByLabelText(APP_MODEL_INPUT_LABEL)
    fireEvent.change(input, { target: { value: 'thaitea/laya-vision' } })
    expect(screen.getByText('— not added', { exact: false })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: APP_MODEL_ADD_BUTTON }))
    await waitFor(() => expect(AppModelsAPI.add).toHaveBeenCalledWith('thaitea/laya-vision'))
    expect(await screen.findByText(APP_MODEL_CONVERTING)).toBeInTheDocument()
    expect(screen.queryByText('— not added', { exact: false })).not.toBeInTheDocument()
  })

  it('Choose… fills the folder from the backend’s dialog; Add and Cancel sit in the row', async () => {
    vi.spyOn(AppModelsAPI, 'pick').mockResolvedValue({ path: '/Users/me/laya-run/best' })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: APP_MODEL_CHOOSE }))
    expect(await screen.findByText('best')).toBeInTheDocument()
    const addRow = screen.getByText(APP_MODEL_ADD).closest('[data-add]') as HTMLElement
    fireEvent.click(within(addRow).getAllByRole('button', { name: CULLING_MODELS_CANCEL })[0]!)
    expect(screen.queryByText('best')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: APP_MODEL_CHOOSE }))
    await screen.findByText('best')
    fireEvent.click(within(addRow).getAllByRole('button', { name: APP_MODEL_ADD_BUTTON })[0]!)
    await waitFor(() => expect(AppModelsAPI.add).toHaveBeenCalledWith('/Users/me/laya-run/best'))
  })

  it('a dismissed dialog changes nothing', async () => {
    vi.spyOn(AppModelsAPI, 'pick').mockResolvedValue({ path: null })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: APP_MODEL_CHOOSE }))
    await waitFor(() => expect(screen.getByRole('button', { name: APP_MODEL_CHOOSE })).toBeEnabled())
    expect(screen.getByText(APP_MODEL_ADD_HINT)).toBeInTheDocument()
    expect(screen.queryByText('— not added', { exact: false })).not.toBeInTheDocument()
  })

  it('without a dialog for this browser, there is no Choose… and the field is open', async () => {
    pickerAvailable = false
    renderSection()
    expect(await screen.findByLabelText(APP_MODEL_INPUT_LABEL)).toBeVisible()
    expect(screen.queryByRole('button', { name: APP_MODEL_CHOOSE })).not.toBeInTheDocument()
  })

  it('shows why a source was refused, and keeps it to correct', async () => {
    vi.spyOn(AppModelsAPI, 'add').mockRejectedValue(new Error('Already converting as laya-base'))
    pickerAvailable = false
    renderSection()
    const input = await screen.findByLabelText(APP_MODEL_INPUT_LABEL)
    fireEvent.change(input, { target: { value: 'thaitea/laya-vision' } })
    fireEvent.click(screen.getByRole('button', { name: APP_MODEL_ADD_BUTTON }))
    expect(await screen.findByText('Already converting as laya-base')).toBeInTheDocument()
    expect(input).toHaveValue('thaitea/laya-vision')
  })

  it('refreshes when a conversion job finishes', async () => {
    models = [{ name: 'laya-base', source: 'thaitea/laya-vision', revision: null, status: 'converting', job_id: 'job-1' }]
    renderSection()
    await screen.findByText(APP_MODEL_CONVERTING)
    models = [ready('laya-base', 'thaitea/laya-vision')]
    socket.onJobUpdated?.({ id: 'other', type: 'batch_describe', status: 'completed' } as Job)
    expect(AppModelsAPI.list).toHaveBeenCalledTimes(1)
    socket.onJobUpdated?.({ id: 'job-1', type: 'laya_model_install', status: 'completed' } as Job)
    expect(await screen.findByText(APP_MODEL_READY)).toBeInTheDocument()
  })
})
