import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { CullAPI, FrameSubstanceAPI } from '../api'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

const cullingChangedMock = vi.fn()
vi.mock('../../data/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/keys')>()
  return {
    ...actual,
    cullingChanged: () => cullingChangedMock(),
  }
})

describe('CullAPI mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    cullingChangedMock.mockClear()
  })

  it('recordAction calls cullingChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    await CullAPI.recordAction('photo.jpg', 'agrees_with_filter')
    expect(cullingChangedMock).toHaveBeenCalledTimes(1)
  })

  it('recordAction does not call cullingChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullAPI.recordAction('photo.jpg', 'agrees_with_filter')).rejects.toThrow()
    expect(cullingChangedMock).not.toHaveBeenCalled()
  })

  it('withdrawShouldHaveBeenFiltered calls cullingChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, removed: 1 }) })
    await CullAPI.withdrawShouldHaveBeenFiltered('photo.jpg')
    expect(cullingChangedMock).toHaveBeenCalledTimes(1)
  })

  it('withdrawShouldHaveBeenFiltered does not call cullingChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullAPI.withdrawShouldHaveBeenFiltered('photo.jpg')).rejects.toThrow()
    expect(cullingChangedMock).not.toHaveBeenCalled()
  })

  it('sendPhotos calls cullingChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sent_by_hand: ['a.jpg'], job_id: null, skipped_complete: 0 }),
    })
    await CullAPI.sendPhotos(['a.jpg'])
    expect(cullingChangedMock).toHaveBeenCalledTimes(1)
  })

  it('sendPhotos does not call cullingChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(CullAPI.sendPhotos(['a.jpg'])).rejects.toThrow()
    expect(cullingChangedMock).not.toHaveBeenCalled()
  })
})

describe('FrameSubstanceAPI mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    cullingChangedMock.mockClear()
  })

  it('createOverride calls cullingChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ image_key: 'photo.jpg', has_override: true }),
    })
    await FrameSubstanceAPI.createOverride('photo.jpg')
    expect(cullingChangedMock).toHaveBeenCalledTimes(1)
  })

  it('createOverride does not call cullingChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(FrameSubstanceAPI.createOverride('photo.jpg')).rejects.toThrow()
    expect(cullingChangedMock).not.toHaveBeenCalled()
  })

  it('deleteOverride calls cullingChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ image_key: 'photo.jpg', has_override: false }),
    })
    await FrameSubstanceAPI.deleteOverride('photo.jpg')
    expect(cullingChangedMock).toHaveBeenCalledTimes(1)
  })

  it('deleteOverride does not call cullingChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(FrameSubstanceAPI.deleteOverride('photo.jpg')).rejects.toThrow()
    expect(cullingChangedMock).not.toHaveBeenCalled()
  })
})
