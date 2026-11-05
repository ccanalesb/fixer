import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deleteMatching } from '../../data/cache'
import { ImagesAPI } from '../api'

const fetchMock = vi.fn()
globalThis.fetch = fetchMock

const stacksChangedMock = vi.fn()
vi.mock('../../data/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/keys')>()
  return {
    ...actual,
    stacksChanged: () => stacksChangedMock(),
  }
})

function okJson(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('ImagesAPI stack and posted mutations', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    stacksChangedMock.mockClear()
  })

  it('acceptStackSuggestion calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        stack: { stack_id: 1, representative_key: 'a', stack_member_count: 2, member_keys: ['a', 'b'] },
      }),
    )
    await ImagesAPI.acceptStackSuggestion('a', 'b')
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('acceptStackSuggestion does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.acceptStackSuggestion('a', 'b')).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })

  it('rejectStackSuggestion calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ image_key_a: 'a', image_key_b: 'b', rejected: true }))
    await ImagesAPI.rejectStackSuggestion('a', 'b')
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('rejectStackSuggestion does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.rejectStackSuggestion('a', 'b')).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })

  it('splitStackMember calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ stack_id: 1, split_image_key: 'b', remaining_member_count: 1 }))
    await ImagesAPI.splitStackMember(1, 'b')
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('splitStackMember does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.splitStackMember(1, 'b')).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })

  it('mergeStacks calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ target_stack_id: 1, source_stack_id: 2, member_count: 3 }))
    await ImagesAPI.mergeStacks(1, 2)
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('mergeStacks does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.mergeStacks(1, 2)).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })

  it('setStackRepresentative calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ stack_id: 1, representative_key: 'a' }))
    await ImagesAPI.setStackRepresentative(1, 'a')
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('setStackRepresentative does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.setStackRepresentative(1, 'a')).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })

  it('setInstagramPosted calls stacksChanged after the server answers', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ image_key: 'photo.jpg', instagram_posted: true }))
    await ImagesAPI.setInstagramPosted('photo.jpg', true)
    expect(stacksChangedMock).toHaveBeenCalledTimes(1)
  })

  it('setInstagramPosted does not call stacksChanged when the request fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' })
    await expect(ImagesAPI.setInstagramPosted('photo.jpg', true)).rejects.toThrow()
    expect(stacksChangedMock).not.toHaveBeenCalled()
  })
})
