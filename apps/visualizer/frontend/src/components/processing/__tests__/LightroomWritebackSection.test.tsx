import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { LightroomWritebackSection } from '../LightroomWritebackSection'
import { ConfigAPI, JobsAPI, LrWritebackAPI } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import type { CatalogKind } from '../../../types/config'
import {
  FOLDER_WRITEBACK_LOADING,
  FOLDER_WRITEBACK_STOP_WRITING_TITLE,
  FOLDER_WRITEBACK_WRITE,
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
  catalog_kind: 'lightroom' as const,
  catalog_path: '/tmp/cat',
  catalog_write_available: true,
  catalog_write_unavailable_reason: null,
  counts: {
    stars: { pending: 0, written: 0, skipped: 0 },
    reject: { pending: 0, written: 0, skipped: 0 },
  },
}

function mockCatalogKind(catalog_kind: CatalogKind) {
  vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
    catalog_path: '/tmp/cat',
    resolved_path: '/tmp/cat',
    exists: true,
    catalog_kind,
    photo_count: 0,
    folder_count: null,
    unreadable_directories: [],
    picker_available: false,
  })
}

const runningWriteback = [
  {
    id: 'job-1',
    type: 'lr_writeback',
    status: 'running',
  } as Awaited<ReturnType<typeof JobsAPI.getActive>>[number],
]

function renderSection() {
  return render(
    <MemoryRouter>
      <LightroomWritebackSection />
    </MemoryRouter>,
  )
}

describe('LightroomWritebackSection', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.restoreAllMocks()
    mockCatalogKind('lightroom')
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue([])
  })

  it('says the folder loading text on a folder catalog before the settings arrive', async () => {
    mockCatalogKind('folder')
    vi.spyOn(LrWritebackAPI, 'getSettings').mockReturnValue(new Promise(() => {}))
    renderSection()
    expect(await screen.findByText(FOLDER_WRITEBACK_LOADING)).toBeInTheDocument()
  })

  it('asks to stop writing to the photo files on a folder catalog', async () => {
    mockCatalogKind('folder')
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      catalog_kind: 'folder',
      write_stars: true,
    })
    vi.spyOn(JobsAPI, 'getActive').mockResolvedValue(runningWriteback)
    renderSection()
    const [starsCheckbox] = await screen.findAllByRole('checkbox')
    fireEvent.click(starsCheckbox!)
    expect(await screen.findByText(FOLDER_WRITEBACK_STOP_WRITING_TITLE)).toBeInTheDocument()
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

  it('shows write enqueue error for a folder catalog', async () => {
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue({
      ...baseSettings,
      catalog_kind: 'folder',
      write_reject: true,
    })
    vi.spyOn(LrWritebackAPI, 'write').mockRejectedValue(new Error('Catalog unavailable for write-back.'))
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: FOLDER_WRITEBACK_WRITE }))
    expect(await screen.findByText('Catalog unavailable for write-back.')).toBeInTheDocument()
  })

  it('folder turn-on shows dry-run counts and PATCHes only after confirm', async () => {
    const folderSettings = {
      ...baseSettings,
      catalog_kind: 'folder' as const,
      catalog_path: '/Volumes/Photos',
    }
    vi.spyOn(LrWritebackAPI, 'getSettings').mockResolvedValue(folderSettings)
    const preview = vi.spyOn(LrWritebackAPI, 'turnOnPreview').mockResolvedValue({
      new_sidecar: 2,
      update_sidecar: 1,
      embedded: 4,
    })
    const patch = vi.spyOn(LrWritebackAPI, 'patchSettings').mockResolvedValue({
      ...folderSettings,
      write_stars: true,
    })
    renderSection()
    const [starsCheckbox] = await screen.findAllByRole('checkbox')
    fireEvent.click(starsCheckbox!)
    expect(preview).toHaveBeenCalledWith('stars')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(patch).toHaveBeenCalledWith({ write_stars: true })
  })
})
