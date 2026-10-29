import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CatalogImportStageChecklist } from '../CatalogImportStageChecklist'
import type { Job } from '../../../types/job'
import { CLIP_DOWNLOAD_ROW_LABEL } from '../../../utils/clipModelDownload'

function makeJob(partial: Partial<Job>): Job {
  return {
    id: 'job-1',
    type: 'catalog_cache_build',
    status: 'running',
    progress: 29,
    current_step: 'Downloading the image model (once) — 80 / 352 MB',
    logs: [],
    logs_total: 0,
    warning_count: 0,
    error_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    metadata: {},
    clip_model_download_loaded_bytes: 80_000_000,
    clip_model_download_total_bytes: 351_685_709,
    ...partial,
  }
}

describe('CatalogImportStageChecklist', () => {
  it('shows the CLIP download row with MB progress while downloading', () => {
    render(
      <CatalogImportStageChecklist
        job={makeJob({})}
        expectClipDownloadInRun
      />,
    )
    expect(screen.getByTestId('catalog-import-clip-download-row')).toBeTruthy()
    expect(screen.getByText(CLIP_DOWNLOAD_ROW_LABEL)).toBeTruthy()
    expect(screen.getByText('80 / 352 MB')).toBeTruthy()
  })

  it('shows failure message under the download row', () => {
    const error =
      'Could not download the image model (about 350 MB) from huggingface.co. Check the internet connection and retry.'
    render(
      <CatalogImportStageChecklist
        job={makeJob({
          status: 'failed',
          progress: 29,
          error,
          clip_model_download_loaded_bytes: 0,
          current_step: null,
        })}
        expectClipDownloadInRun
      />,
    )
    expect(screen.getByTestId('catalog-import-clip-download-error')).toHaveTextContent(error)
    expect(screen.getByText("couldn't connect")).toBeTruthy()
  })

  it('keeps the reserved slot when no download is expected', () => {
    render(<CatalogImportStageChecklist job={makeJob({ progress: 10 })} />)
    expect(screen.getByTestId('catalog-import-clip-slot')).toBeTruthy()
    expect(screen.queryByTestId('catalog-import-clip-download-row')).toBeNull()
  })
})
