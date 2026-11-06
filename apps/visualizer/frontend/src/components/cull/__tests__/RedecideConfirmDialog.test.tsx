import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CULL_REDECIDE_CONFIRM_BODY,
  CULL_REDECIDE_CONFIRM_BODY_FOLDER,
  CULLING_CANCEL,
} from '../../../constants/strings'
import { ConfigAPI } from '../../../services/api'
import { deleteMatching } from '../../../data/cache'
import { RedecideConfirmDialog } from '../RedecideConfirmDialog'

describe('RedecideConfirmDialog', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.restoreAllMocks()
  })

  it('uses Lightroom copy when body is omitted and the catalog is a .lrcat', async () => {
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/test.lrcat',
      resolved_path: '/tmp/test.lrcat',
      exists: true,
      catalog_kind: 'lightroom',
      photo_count: 0,
      folder_count: null,
      unreadable_directories: [],
      picker_available: false,
    })
    render(
      <RedecideConfirmDialog title="Save?" confirmLabel="Save" onCancel={() => {}} onConfirm={() => {}} />,
    )
    expect(await screen.findByText(CULL_REDECIDE_CONFIRM_BODY)).toBeInTheDocument()
  })

  it('uses folder copy when body is omitted and the catalog is a folder', async () => {
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/photos',
      resolved_path: '/tmp/photos',
      exists: true,
      catalog_kind: 'folder',
      photo_count: 0,
      folder_count: 0,
      unreadable_directories: [],
      picker_available: false,
    })
    render(
      <RedecideConfirmDialog title="Save?" confirmLabel="Save" onCancel={() => {}} onConfirm={() => {}} />,
    )
    expect(await screen.findByText(CULL_REDECIDE_CONFIRM_BODY_FOLDER)).toBeInTheDocument()
    expect(screen.queryByText(CULL_REDECIDE_CONFIRM_BODY)).toBeNull()
  })

  it('honours an explicit body over catalog kind', async () => {
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/photos',
      resolved_path: '/tmp/photos',
      exists: true,
      catalog_kind: 'folder',
      photo_count: 0,
      folder_count: 0,
      unreadable_directories: [],
      picker_available: false,
    })
    render(
      <RedecideConfirmDialog
        title="Custom"
        body="Custom body"
        confirmLabel="OK"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    )
    expect(await screen.findByText('Custom body')).toBeInTheDocument()
  })

  it('calls onCancel when Escape is pressed', async () => {
    vi.spyOn(ConfigAPI, 'getCatalog').mockResolvedValue({
      catalog_path: '/tmp/test.lrcat',
      resolved_path: '/tmp/test.lrcat',
      exists: true,
      catalog_kind: 'lightroom',
      photo_count: 0,
      folder_count: null,
      unreadable_directories: [],
      picker_available: false,
    })
    const onCancel = vi.fn()
    render(
      <RedecideConfirmDialog title="Save?" confirmLabel="Save" onCancel={onCancel} onConfirm={() => {}} />,
    )
    await screen.findByText(CULL_REDECIDE_CONFIRM_BODY)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: CULLING_CANCEL })).toBeInTheDocument()
  })
})
