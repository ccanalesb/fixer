import { Suspense } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CullingModelsSection } from '../processing/CullingModelsSection'
import { TaskAssignmentsBlock } from '../providers/TaskAssignmentsBlock'
import {
  AppModelsAPI,
  ConfigAPI,
  CullingModelsAPI,
  CullingProfilesAPI,
  ScoreForecastQuestionsAPI,
  type AppModel,
  type CullingModelsResponse,
  type CullingStageModel,
  type PipelineSettingResponse,
} from '../../services/api'
import { TASK_OFF_IN_SETTINGS, CULLING_PROFILE_STAGE, TASK_ASSIGNMENTS_HEADING } from '../../constants/strings'
import { deleteMatching } from '../../data/cache'
import { cullingProfilesChanged } from '../../data'

vi.mock('../ui/ProviderModelSelect', () => ({ ProviderModelSelect: () => null }))

type Config = PipelineSettingResponse['config']

let stored: Config
let stages: CullingModelsResponse

const stage = (over: Partial<CullingStageModel> = {}): CullingStageModel => ({
  endpoint: 'this_app',
  model: null,
  answered: { photos: 0, model: null },
  usable: { problem: 'no_model', job_id: null, provider_name: null },
  ...over,
})
const ready = (name: string): AppModel => ({ name, source: null, revision: null, status: 'ready', job_id: null })

beforeEach(() => {
  vi.restoreAllMocks()
  deleteMatching(() => true)
  stored = {
    culling_profiles_enabled: true,
    culling_profiles_filter_enabled: true,
    culling_profiles: [],
    score_forecast: { enabled: true, threshold: 0.111, high_from_level: 8, excused_at: 0.5 },
  }
  stages = {
    culling_profile: stage(),
    score_forecast: stage(),
    total_photos: 3,
    system_one_providers: [],
  }
  vi.spyOn(CullingProfilesAPI, 'getPipeline').mockImplementation(async () => ({ version: 1, config: stored }))
  vi.spyOn(CullingProfilesAPI, 'saveCullingProfileSwitches').mockImplementation(async (body) => {
    if (body.enabled !== undefined) stored = { ...stored, culling_profiles_enabled: body.enabled }
    cullingProfilesChanged()
    return { version: 2, redecide_job_id: null }
  })
  vi.spyOn(CullingModelsAPI, 'get').mockImplementation(async () => stages)
  vi.spyOn(AppModelsAPI, 'list').mockResolvedValue({ models: [ready('m')], picker_available: true })
  vi.spyOn(ScoreForecastQuestionsAPI, 'get').mockResolvedValue({ questions: [], version: 0, perspectives: [] })
  vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
    catalog_path: '/tmp/test.lrcat',
    resolved_path: '/tmp/test.lrcat',
    exists: true,
    catalog_kind: 'lightroom',
    photo_count: 0,
    folder_count: null,
    unreadable_directories: [],
    picker_available: false,
  })
})

function renderBoth() {
  return render(
    <MemoryRouter>
      <Suspense fallback={null}>
        <CullingModelsSection />
        <TaskAssignmentsBlock
          openAiProviders={[]}
          fallbackOrder={[]}
          modelCache={{}}
          defaults={{}}
          defaultsNotice={null}
          onRefreshBundle={() => {}}
        />
      </Suspense>
    </MemoryRouter>,
  )
}

describe('cullingProfilesChanged pipeline cache', () => {
  it('changing a culling-profile switch in Settings refreshes a mounted TaskAssignmentsBlock', async () => {
    renderBoth()
    await screen.findByText(TASK_ASSIGNMENTS_HEADING)
    const cullRow = document.getElementById('task-culling_profile') as HTMLElement
    expect(within(cullRow).queryByText(TASK_OFF_IN_SETTINGS)).not.toBeInTheDocument()

    const settingsSwitch = await screen.findByRole('checkbox', { name: CULLING_PROFILE_STAGE })
    fireEvent.click(settingsSwitch)

    await waitFor(() => expect(CullingProfilesAPI.saveCullingProfileSwitches).toHaveBeenCalledWith({ enabled: false }))
    await waitFor(() => expect(within(cullRow).getByText(TASK_OFF_IN_SETTINGS)).toBeInTheDocument())
  })
})
