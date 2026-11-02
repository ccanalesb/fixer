import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { IMAGE_DETAIL_POSTED_ARIA } from '../../../../constants/strings'
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
        image={{
          image_type: 'catalog',
          key: 'k',
          filename: 'L1004434.DNG',
          filepath: '/Volumes/Photos/L1004434.DNG',
          width: 6000,
          height: 4000,
        }}
      />,
    )
    expect(screen.getByText('L1004434.DNG')).toBeInTheDocument()
    expect(screen.getByText('/Volumes/Photos/L1004434.DNG')).toBeInTheDocument()
    expect(screen.getByText('6000 × 4000')).toBeInTheDocument()
  })

  it('toggles posted via the API and tells the modal at once', async () => {
    const spy = vi.spyOn(ImagesAPI, 'setInstagramPosted').mockResolvedValue({ key: 'k', instagram_posted: true })
    const onPostedChange = vi.fn()
    render(<FileTab image={{ image_type: 'catalog', key: 'k', instagram_posted: false }} onPostedChange={onPostedChange} />)

    const checkbox = screen.getByRole('checkbox', { name: IMAGE_DETAIL_POSTED_ARIA })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(checkbox)

    expect(onPostedChange).toHaveBeenCalledWith(true)
    expect(checkbox).toBeChecked()
    await waitFor(() => expect(spy).toHaveBeenCalledWith('k', true))
  })
})
