import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Pagination } from '../Pagination'

describe('Pagination', () => {
  it('should render current page as selected among page numbers', () => {
    render(<Pagination currentPage={2} totalPages={5} onPageChange={vi.fn()} />)
    const current = screen.getByRole('button', { name: '2' })
    expect(current.className).toContain('border-accent')
  })

  it('should call onPageChange with previous page', () => {
    const onChange = vi.fn()
    render(<Pagination currentPage={3} totalPages={5} onPageChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('should call onPageChange with next page', () => {
    const onChange = vi.fn()
    render(<Pagination currentPage={3} totalPages={5} onPageChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onChange).toHaveBeenCalledWith(4)
  })

  it('should disable previous on first page', () => {
    render(<Pagination currentPage={1} totalPages={5} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  })

  it('should disable next on last page', () => {
    render(<Pagination currentPage={5} totalPages={5} onPageChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('should not render when totalPages <= 1', () => {
    const { container } = render(<Pagination currentPage={1} totalPages={1} onPageChange={vi.fn()} />)
    expect(container.firstElementChild).toBeNull()
  })

  it('should disable all controls when disabled', () => {
    render(<Pagination currentPage={2} totalPages={5} onPageChange={vi.fn()} disabled />)
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '1' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '2' })).toBeDisabled()
    expect(screen.getByLabelText('Go to page')).toBeDisabled()
  })

  describe('page field', () => {
    const field = () => screen.getByLabelText('Go to page') as HTMLInputElement

    it('shows the current page and the total', () => {
      render(<Pagination currentPage={3} totalPages={624} onPageChange={vi.fn()} />)
      expect(field().value).toBe('3')
      expect(screen.getByText(/of 624/)).toBeTruthy()
    })

    it('jumps to the typed page on Enter', () => {
      const onChange = vi.fn()
      render(<Pagination currentPage={3} totalPages={624} onPageChange={onChange} />)
      fireEvent.change(field(), { target: { value: '120' } })
      expect(onChange).not.toHaveBeenCalled()
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(onChange).toHaveBeenCalledWith(120)
    })

    it('clamps a page past either end', () => {
      const onChange = vi.fn()
      render(<Pagination currentPage={3} totalPages={624} onPageChange={onChange} />)
      fireEvent.change(field(), { target: { value: '9999' } })
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(onChange).toHaveBeenLastCalledWith(624)
      fireEvent.change(field(), { target: { value: '0' } })
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(onChange).toHaveBeenLastCalledWith(1)
    })

    it('puts the current page back when the input is not a number or the field loses focus', () => {
      const onChange = vi.fn()
      render(<Pagination currentPage={3} totalPages={624} onPageChange={onChange} />)
      fireEvent.change(field(), { target: { value: 'abc' } })
      fireEvent.keyDown(field(), { key: 'Enter' })
      expect(field().value).toBe('3')
      fireEvent.change(field(), { target: { value: '50' } })
      fireEvent.blur(field())
      expect(field().value).toBe('3')
      expect(onChange).not.toHaveBeenCalled()
    })

    it('follows the page when it changes from outside', () => {
      const { rerender } = render(<Pagination currentPage={3} totalPages={624} onPageChange={vi.fn()} />)
      rerender(<Pagination currentPage={4} totalPages={624} onPageChange={vi.fn()} />)
      expect(field().value).toBe('4')
    })
  })
})
