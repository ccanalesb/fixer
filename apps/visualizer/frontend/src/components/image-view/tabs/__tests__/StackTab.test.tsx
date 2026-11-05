import { Suspense } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { deleteMatching } from '../../../../data/cache'
import { StackTab } from '../StackTab'
import { CATALOG_STACK_SPLIT_OUT } from '../../../../constants/strings'

const mockGetStackMembers = vi.fn()
const mockSplitStackMember = vi.fn()

vi.mock('../../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api')>()
  return {
    ...actual,
    ImagesAPI: {
      ...actual.ImagesAPI,
      getStackMembers: (...args: unknown[]) => mockGetStackMembers(...args),
      splitStackMember: (...args: unknown[]) => mockSplitStackMember(...args),
    },
  }
})

const memberA = {
  key: 'a.jpg',
  filename: 'a.jpg',
  is_stack_representative: true,
}
const memberB = {
  key: 'b.jpg',
  filename: 'b.jpg',
  is_stack_representative: false,
}

function renderTab() {
  return render(
    <Suspense fallback={null}>
      <StackTab stackId={9} imageKey="a.jpg" />
    </Suspense>,
  )
}

describe('StackTab', () => {
  beforeEach(() => {
    deleteMatching(() => true)
    vi.clearAllMocks()
    mockGetStackMembers.mockResolvedValue({ items: [memberA, memberB] })
    mockSplitStackMember.mockImplementation(async () => {
      const { stacksChanged } = await import('../../../../data/keys')
      stacksChanged()
      return { stack_id: 9, split_image_key: 'b.jpg', remaining_member_count: 1 }
    })
  })

  it('refetches stack members after a split without manual refresh', async () => {
    renderTab()
    expect(await screen.findByText('b.jpg')).toBeInTheDocument()

    mockGetStackMembers.mockResolvedValue({ items: [memberA] })

    fireEvent.click(screen.getByRole('button', { name: CATALOG_STACK_SPLIT_OUT }))
    const confirmButtons = screen.getAllByRole('button', { name: CATALOG_STACK_SPLIT_OUT })
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!)

    await waitFor(() => {
      expect(mockSplitStackMember).toHaveBeenCalledWith(9, 'a.jpg')
    })
    await waitFor(() => {
      expect(mockGetStackMembers.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    await waitFor(() => {
      expect(screen.queryByText('b.jpg')).not.toBeInTheDocument()
    })
  })
})
