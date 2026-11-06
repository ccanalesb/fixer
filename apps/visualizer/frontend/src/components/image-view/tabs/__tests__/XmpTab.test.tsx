import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteMatching } from '../../../../data/cache'
import { ImagesAPI, LrWritebackAPI, type FolderXmpDetailResponse } from '../../../../services/api'
import { XMP_DETAIL_SECTION, XMP_FILE_MISSING, XMP_NO_METADATA_HINT } from '../../../../constants/strings'
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
})
