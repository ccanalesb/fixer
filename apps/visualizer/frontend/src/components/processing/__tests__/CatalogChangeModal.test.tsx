import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CatalogChangeModal } from '../CatalogChangeModal'

const sameOrDifferentPreview = {
  unchanged: false,
  current: {
    catalog_path: '/a/old.lrcat',
    resolved_path: '/a/old.lrcat',
    catalog_kind: 'lightroom' as const,
    display_name: 'old',
    exists: true,
    library_photo_count: 100,
    has_library: true,
  },
  next: {
    catalog_path: '/a/new.lrcat',
    resolved_path: '/a/new.lrcat',
    catalog_kind: 'lightroom' as const,
    display_name: 'new',
    exists: true,
    library_photo_count: null,
    has_library: false,
  },
  ask_same_or_different: true,
  jobs_to_cancel: [],
}

const switchPreview = {
  ...sameOrDifferentPreview,
  ask_same_or_different: false,
  next: {
    ...sameOrDifferentPreview.next,
    catalog_path: '/photos',
    resolved_path: '/photos',
    catalog_kind: 'folder' as const,
    display_name: 'photos',
  },
  jobs_to_cancel: [
    { id: 'job-1', type: 'batch_describe', status: 'running' },
    { id: 'job-2', type: 'batch_score', status: 'pending' },
  ],
}

describe('CatalogChangeModal', () => {
  it('shows Update the path when same catalog is chosen', () => {
    render(
      <CatalogChangeModal
        preview={sameOrDifferentPreview}
        sameChoice="same"
        onSameChoice={() => {}}
        saving={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Update the path' })).toBeEnabled()
  })

  it('disables confirm until a same-or-different choice is made', () => {
    render(
      <CatalogChangeModal
        preview={sameOrDifferentPreview}
        sameChoice={null}
        onSameChoice={() => {}}
        saving={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Switch catalog' })).toBeDisabled()
  })

  it('shows switch title, consequences, cancelled jobs, and user-facing statuses', () => {
    render(
      <CatalogChangeModal
        preview={switchPreview}
        sameChoice="different"
        onSameChoice={() => {}}
        saving={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Switch to photos?' })).toBeInTheDocument()
    expect(screen.getByText(/starts empty/i)).toBeInTheDocument()
    expect(screen.getByText(/Everything for/)).toHaveTextContent('old')
    expect(screen.getByText(/Switching cancels 2 jobs on photos:/)).toBeInTheDocument()
    expect(screen.getByText(/Describe — Running/)).toBeInTheDocument()
    expect(screen.getByText(/Score — Queued/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch catalog' })).toBeEnabled()
  })

  it('calls onConfirm when Switch catalog is pressed', () => {
    const onConfirm = vi.fn()
    render(
      <CatalogChangeModal
        preview={switchPreview}
        sameChoice="different"
        onSameChoice={() => {}}
        saving={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch catalog' }))
    expect(onConfirm).toHaveBeenCalled()
  })
})
