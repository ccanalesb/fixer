import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import {
  FILE_MISSING_STATUS_TITLE,
  IMAGE_DETAIL_POSTED_ARIA,
  LR_MISSING_STATUS_TITLE,
} from '../../../../constants/strings'
import { ImagesAPI } from '../../../../services/api'
import { FileTab } from '../FileTab'

describe('FileTab', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('lists the file facts', () => {
    render(
      <FileTab
        catalogKind="lightroom"
        image={{
          image_type: 'catalog',
          key: 'k',
          filename: 'L1004434.DNG',
          filepath: '/Volumes/Photos/L1004434.DNG',
          width: 6000,
          height: 4000,
          title: 'My title',
          caption: 'My caption',
        }}
      />,
    )
    expect(screen.getByText('L1004434.DNG')).toBeInTheDocument()
    expect(screen.getByText('My title')).toBeInTheDocument()
    expect(screen.getByText('My caption')).toBeInTheDocument()
    expect(screen.getByText('/Volumes/Photos/L1004434.DNG')).toBeInTheDocument()
    expect(screen.getByText('6000 × 4000')).toBeInTheDocument()
  })

  it('omits title and caption on a folder catalog', () => {
    render(
      <FileTab
        catalogKind="folder"
        image={{
          image_type: 'catalog',
          key: 'k',
          filename: 'a.jpg',
          title: 'Hidden',
          caption: 'Also hidden',
        }}
      />,
    )
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.queryByText('Also hidden')).toBeNull()
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
  })

  it('toggles posted via the API and tells the modal at once', async () => {
    const spy = vi.spyOn(ImagesAPI, 'setInstagramPosted').mockResolvedValue({ key: 'k', instagram_posted: true })
    const onPostedChange = vi.fn()
    render(
      <FileTab
        catalogKind="lightroom"
        image={{ image_type: 'catalog', key: 'k', instagram_posted: false }}
        onPostedChange={onPostedChange}
      />,
    )

    const checkbox = screen.getByRole('checkbox', { name: IMAGE_DETAIL_POSTED_ARIA })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)

    expect(onPostedChange).toHaveBeenCalledWith(true)
    expect(checkbox).toBeChecked()
    await waitFor(() => expect(spy).toHaveBeenCalledWith('k', true))
  })

  it('shows a file-missing status for a folder catalog', () => {
    render(
      <FileTab
        catalogKind="folder"
        image={{
          image_type: 'catalog',
          key: 'k',
          filepath: '/photos/missing.jpg',
          catalog_missing_since: '2026-11-03T12:00:00Z',
        }}
      />,
    )
    expect(screen.getByText(FILE_MISSING_STATUS_TITLE)).toBeInTheDocument()
    expect(screen.getByText(/Not found at/)).toBeInTheDocument()
  })

  it('shows a not-in-catalog status for a Lightroom catalog', () => {
    render(
      <FileTab
        catalogKind="lightroom"
        image={{
          image_type: 'catalog',
          key: 'k',
          catalog_missing_since: '2026-11-03T12:00:00Z',
        }}
      />,
    )
    expect(screen.getByText(LR_MISSING_STATUS_TITLE)).toBeInTheDocument()
  })
})
