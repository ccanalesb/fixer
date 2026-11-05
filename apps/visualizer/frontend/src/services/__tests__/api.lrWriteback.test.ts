import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { LrWritebackAPI } from '../api'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

const lightroomWrittenMock = vi.fn()
vi.mock('../../data/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/keys')>()
  return {
    ...actual,
    lightroomWritten: () => lightroomWrittenMock(),
  }
})

function okJson(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('LrWritebackAPI mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    lightroomWrittenMock.mockClear()
  })

  it('patchSettings calls lightroomWritten after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ write_stars: true }))
    await LrWritebackAPI.patchSettings({ write_stars: true })
    expect(lightroomWrittenMock).toHaveBeenCalledTimes(1)
  })

  it('patchSettings does not call lightroomWritten when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(LrWritebackAPI.patchSettings({ write_stars: true })).rejects.toThrow()
    expect(lightroomWrittenMock).not.toHaveBeenCalled()
  })

  it('write calls lightroomWritten after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ job_id: 'j1' }))
    await LrWritebackAPI.write()
    expect(lightroomWrittenMock).toHaveBeenCalledTimes(1)
  })

  it('write does not call lightroomWritten when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(LrWritebackAPI.write()).rejects.toThrow()
    expect(lightroomWrittenMock).not.toHaveBeenCalled()
  })

  it('undo calls lightroomWritten after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ ok: true }))
    await LrWritebackAPI.undo('photo.jpg', 'stars')
    expect(lightroomWrittenMock).toHaveBeenCalledTimes(1)
  })

  it('undo does not call lightroomWritten when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(LrWritebackAPI.undo('photo.jpg', 'stars')).rejects.toThrow()
    expect(lightroomWrittenMock).not.toHaveBeenCalled()
  })
})
