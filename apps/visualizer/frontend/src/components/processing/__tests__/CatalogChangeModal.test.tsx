import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CatalogChangeModal } from '../CatalogChangeModal'

const preview = {
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

describe('CatalogChangeModal', () => {
  it('shows Update the path when same catalog is chosen', () => {
    render(
      <CatalogChangeModal
        preview={preview}
        sameChoice="same"
        onSameChoice={() => {}}
        saving={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Update the path' })).toBeEnabled()
  })
})
