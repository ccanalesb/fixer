import { Suspense } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../../../data/cache'
import { ImagesAPI, LrWritebackAPI, type FolderXmpDetailResponse } from '../../../../services/api'
import {
  LR_WRITEBACK_BEFORE_NO_RATING,
  LR_WRITEBACK_UNDO,
  LR_WRITEBACK_UNDO_STARS_ROW,
  FOLDER_WRITEBACK_WRITTEN_DETAIL,
  FOLDER_WRITEBACK_USER_CHANGED,
  XMP_DETAIL_SECTION,
  XMP_FILE_MISSING,
  XMP_NO_METADATA_HINT,
} from '../../../../constants/strings'
import { formatDateTime } from '../../../../utils/date'
import { XmpTab } from '../XmpTab'

function sampleDetail(overrides: Partial<FolderXmpDetailResponse> = {}): FolderXmpDetailResponse {
  return {
    image_key: 'k',
    file_missing: false,
    no_metadata_hint: false,
    sidecar_order: [],
    secondary_sidecar_note: null,
    rating: { display: '4★', source: 'sidecar beach.jpg.xmp' },
    reject: { display: null, source: null },
    label: { value: 'Red', source: 'embedded XMP' },
    keywords: { values: ['sand'], source: 'embedded XMP' },
    title: { value: 'At the beach', source: 'embedded XMP' },
    caption: { value: null, source: null },
    copyright: { value: null, source: null },
    ...overrides,
  }
}

describe('XmpTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockRejectedValue(new Error('no writeback'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows field values with their sources from the live file read', async () => {
    vi.spyOn(ImagesAPI, 'getFolderXmpDetail').mockResolvedValue(sampleDetail())
    render(
      <Suspense fallback={null}>
        <XmpTab image={{ image_type: 'catalog', key: 'k' }} />
      </Suspense>,
    )
    expect(await screen.findByText(XMP_DETAIL_SECTION)).toBeInTheDocument()
    expect(screen.getByText('4★')).toBeInTheDocument()
    expect(screen.getByText('sidecar beach.jpg.xmp')).toBeInTheDocument()
    expect(screen.getByText('Red')).toBeInTheDocument()
    expect(screen.getAllByText('embedded XMP').length).toBeGreaterThan(0)
    expect(screen.getByText('At the beach')).toBeInTheDocument()
  })

  it('shows the no-metadata hint when nothing on disk has XMP or IPTC', async () => {
    vi.spyOn(ImagesAPI, 'getFolderXmpDetail').mockResolvedValue(
      sampleDetail({
        no_metadata_hint: true,
        rating: { display: 'no rating', source: null },
        label: { value: null, source: null },
        keywords: { values: [], source: null },
        title: { value: null, source: null },
      }),
    )
    render(
      <Suspense fallback={null}>
        <XmpTab image={{ image_type: 'catalog', key: 'k' }} />
      </Suspense>,
    )
    expect(await screen.findByText(XMP_NO_METADATA_HINT)).toBeInTheDocument()
  })

  it('shows the missing-file notice when file_missing is true', async () => {
    vi.spyOn(ImagesAPI, 'getFolderXmpDetail').mockResolvedValue(
      sampleDetail({ file_missing: true, no_metadata_hint: false }),
    )
    render(
      <Suspense fallback={null}>
        <XmpTab image={{ image_type: 'catalog', key: 'k' }} />
      </Suspense>,
    )
    expect(await screen.findByText(XMP_FILE_MISSING)).toBeInTheDocument()
  })

  it('shows write-back readout from the live file and undoes stars', async () => {
    vi.spyOn(ImagesAPI, 'getFolderXmpDetail').mockResolvedValue(
      sampleDetail({
        rating: { display: 'no rating', source: 'embedded XMP' },
      }),
    )
    let live = 2
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockImplementation(async () => ({
      image_key: 'k',
      rating: {
        live,
        app_wrote: true,
        before_label: LR_WRITEBACK_BEFORE_NO_RATING,
        undo_available: live === 2,
        user_changed: false,
      },
      flag: {
        live_pick: 0,
        app_wrote_reject: false,
        undo_available: false,
        user_changed: false,
      },
      keywords: ['lrt-auto-stars'],
      strong_dimensions_line: null,
      written_at: '2026-03-15T14:30:00.000Z',
      written_file_label: 'embed.jpg',
      user_changed_message: null,
    }))
    const undoSpy = vi.spyOn(LrWritebackAPI, 'undo').mockImplementation(async () => {
      live = 0
      return { ok: true }
    })

    render(
      <Suspense fallback={null}>
        <XmpTab image={{ image_type: 'catalog', key: 'k' }} />
      </Suspense>,
    )

    expect(await screen.findByText('2★')).toBeInTheDocument()
    expect(screen.getByText('written by the app')).toBeInTheDocument()
    expect(screen.getByText(LR_WRITEBACK_BEFORE_NO_RATING)).toBeInTheDocument()
    expect(
      screen.getByText(
        FOLDER_WRITEBACK_WRITTEN_DETAIL('embed.jpg', formatDateTime('2026-03-15T14:30:00.000Z')),
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(LR_WRITEBACK_UNDO_STARS_ROW)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: LR_WRITEBACK_UNDO }))
    expect(undoSpy).toHaveBeenCalledWith('k', 'stars')
  })

  it('shows user-changed warning when the file no longer matches what the app wrote', async () => {
    vi.spyOn(ImagesAPI, 'getFolderXmpDetail').mockResolvedValue(sampleDetail())
    vi.spyOn(LrWritebackAPI, 'getPhoto').mockResolvedValue({
      image_key: 'k',
      rating: {
        live: 4,
        app_wrote: true,
        before_label: null,
        undo_available: false,
        user_changed: true,
      },
      flag: {
        live_pick: 0,
        app_wrote_reject: false,
        undo_available: false,
        user_changed: false,
      },
      keywords: [],
      strong_dimensions_line: null,
      written_at: null,
      written_file_label: null,
      user_changed_message: FOLDER_WRITEBACK_USER_CHANGED('beach.jpg'),
    })

    render(
      <Suspense fallback={null}>
        <XmpTab image={{ image_type: 'catalog', key: 'k' }} />
      </Suspense>,
    )

    expect(await screen.findByText(FOLDER_WRITEBACK_USER_CHANGED('beach.jpg'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: LR_WRITEBACK_UNDO })).toBeNull()
  })
})
