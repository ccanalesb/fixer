import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { LightroomWritebackSection } from '../LightroomWritebackSection'
import { JobsAPI, LrWritebackAPI } from '../../../services/api'
import {
  LR_WRITEBACK_CLOSE_LR,
  LR_WRITEBACK_STARS_SWITCH,
  LR_WRITEBACK_STOP_WRITING_CANCEL,
  LR_WRITEBACK_STOP_WRITING_CONFIRM,
  LR_WRITEBACK_STOP_WRITING_TITLE,
  LR_WRITEBACK_WRITE_TO_LR,
  LR_WRITEBACK_WRITING_JOB_LINK,
  LR_WRITEBACK_WRITING_PROGRESS,
} from '../../../constants/strings'

const baseSettings = {
  write_stars: false,
  write_reject: false,
  stars_profile_slug: null,
  active_profile_slugs: ['default'],
  active_profiles: [{ slug: 'default', name: 'Default culling profile' }],
  catalog_write_available: true,
  catalog_write_unavailable_reason: null,
  counts: { stars: { pending: 0, written: 0 }, reject: { pending: 0, written: 0 } },
}

function renderSection() {
  return render(
    <MemoryRouter>
      <LightroomWritebackSection />
    </MemoryRouter>,
  )
}

describe('LightroomWritebackSection', () => {
  beforeEach(() => {
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([])
  })

  it('shows stars switch label from strings', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue(baseSettings)
    renderSection()
    expect(await screen.findByText(LR_WRITEBACK_STARS_SWITCH)).toBeInTheDocument()
  })

  it('shows spinner while write-back job is running', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: true,
    })
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([
      {
        id: 'job-1',
        type: 'lr_writeback',
        status: 'running',
      } as Awaited<ReturnType<typeof JobsAPI.getActive>>[number],
    ])
    renderSection()
    expect(await screen.findByText(LR_WRITEBACK_WRITING_PROGRESS, { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: LR_WRITEBACK_WRITING_JOB_LINK })).toBeInTheDocument()
  })

  it('shows confirm dialog when turning off with a job running', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: true,
    })
    vi.spyOn(LrWritebackAPI, 'patchSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: false,
    })
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([
      {
        id: 'job-1',
        type: 'lr_writeback',
        status: 'running',
      } as Awaited<ReturnType<typeof JobsAPI.getActive>>[number],
    ])
    renderSection()
    const [starsCheckbox] = await screen.findAllByRole('checkbox')
    fireEvent.click(starsCheckbox!)
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(LR_WRITEBACK_STOP_WRITING_TITLE)).toBeInTheDocument()
  })

  it('"Keep writing" closes dialog and leaves stars on', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: true,
    })
    const patch = vi.spyOn(LrWritebackAPI, 'patchSettings')
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([
      {
        id: 'job-1',
        type: 'lr_writeback',
        status: 'running',
      } as Awaited<ReturnType<typeof JobsAPI.getActive>>[number],
    ])
    renderSection()
    const [starsCheckbox] = await screen.findAllByRole('checkbox')
    fireEvent.click(starsCheckbox)
    fireEvent.click(screen.getByRole('button', { name: LR_WRITEBACK_STOP_WRITING_CANCEL }))
    expect(patch).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Stop and turn off" PATCHes stars off', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: true,
    })
    const patch = vi.spyOn(LrWritebackAPI, 'patchSettings').mockResolvedValue({
      ...baseSettings,
      write_stars: false,
    })
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([
      {
        id: 'job-1',
        type: 'lr_writeback',
        status: 'running',
      } as Awaited<ReturnType<typeof JobsAPI.getActive>>[number],
    ])
    renderSection()
    const [starsCheckbox] = await screen.findAllByRole('checkbox')
    fireEvent.click(starsCheckbox)
    fireEvent.click(screen.getByRole('button', { name: LR_WRITEBACK_STOP_WRITING_CONFIRM }))
    expect(patch).toHaveBeenCalledWith({ write_stars: false })
  })

  it('turns off without dialog when no job is running', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_reject: true,
    })
    const patch = vi.spyOn(LrWritebackAPI, 'patchSettings').mockResolvedValue({
      ...baseSettings,
      write_reject: false,
    })
    renderSection()
    const checkboxes = await screen.findAllByRole('checkbox')
    fireEvent.click(checkboxes[1]!)
    expect(patch).toHaveBeenCalledWith({ write_reject: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('disables Write to Lightroom when catalog is unavailable', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_reject: true,
      catalog_write_available: false,
      catalog_write_unavailable_reason: 'Close Lightroom Classic before writing to catalog.',
    })
    renderSection()
    expect(await screen.findByRole('button', { name: LR_WRITEBACK_WRITE_TO_LR })).toBeDisabled()
    expect(screen.getByText(LR_WRITEBACK_CLOSE_LR)).toBeInTheDocument()
  })

  it('calls write API when button is clicked', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      write_reject: true,
    })
    const write = vi.spyOn(LrWritebackAPI, 'write').mockResolvedValue({ job_id: 'job-new' })
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: LR_WRITEBACK_WRITE_TO_LR }))
    expect(write).toHaveBeenCalled()
  })
})
