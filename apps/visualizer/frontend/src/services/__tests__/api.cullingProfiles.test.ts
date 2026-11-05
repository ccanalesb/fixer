import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { CullingProfilesAPI, ScoreForecastQuestionsAPI } from '../api'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

const cullingProfilesChangedMock = vi.fn()
vi.mock('../../data/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/keys')>()
  return {
    ...actual,
    cullingProfilesChanged: () => cullingProfilesChangedMock(),
  }
})

function okJson(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('CullingProfilesAPI mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    cullingProfilesChangedMock.mockClear()
  })

  it('create calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ slug: 'p1' }))
    await CullingProfilesAPI.create({ slug: 'p1' })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('create does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.create({ slug: 'p1' })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('duplicate calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ slug: 'p2' }))
    await CullingProfilesAPI.duplicate('p1', { new_slug: 'p2' })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('duplicate does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.duplicate('p1', { new_slug: 'p2' })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('saveDefinition calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ profile: {}, version: 1, created: false, impact: {}, cull_job_id: null }))
    await CullingProfilesAPI.saveDefinition('p1', { definition: {}, mode: 'save_only' })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('saveDefinition does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.saveDefinition('p1', { definition: {}, mode: 'save_only' })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('saveRule calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ profile: {}, pipeline_setting_version: 1, redecide_job_id: null }))
    await CullingProfilesAPI.saveRule('p1', {})
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('saveRule does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.saveRule('p1', {})).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('patch calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ profile: {}, pipeline_setting_version: 1, redecide_job_id: null }))
    await CullingProfilesAPI.patch('p1', { name: 'x' })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('patch does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.patch('p1', { name: 'x' })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('saveCullingProfileSwitches calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ version: 2, redecide_job_id: null }))
    await CullingProfilesAPI.saveCullingProfileSwitches({ enabled: false })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('saveCullingProfileSwitches does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.saveCullingProfileSwitches({ enabled: false })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('saveScoreForecast calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ version: 2, redecide_job_id: null }))
    await CullingProfilesAPI.saveScoreForecast({ enabled: true })
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('saveScoreForecast does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullingProfilesAPI.saveScoreForecast({ enabled: true })).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })
})

describe('ScoreForecastQuestionsAPI mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    cullingProfilesChangedMock.mockClear()
  })

  it('save calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ questions: [], version: 1, perspectives: [] }))
    await ScoreForecastQuestionsAPI.save([], 'save_only')
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('save does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ScoreForecastQuestionsAPI.save([], 'save_only')).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })

  it('fromPerspectives calls cullingProfilesChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ questions: [], version: 1, perspectives: [], skipped: [] }))
    await ScoreForecastQuestionsAPI.fromPerspectives()
    expect(cullingProfilesChangedMock).toHaveBeenCalledTimes(1)
  })

  it('fromPerspectives does not call cullingProfilesChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ScoreForecastQuestionsAPI.fromPerspectives()).rejects.toThrow()
    expect(cullingProfilesChangedMock).not.toHaveBeenCalled()
  })
})
