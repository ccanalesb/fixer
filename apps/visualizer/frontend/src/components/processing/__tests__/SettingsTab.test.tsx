import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsTab } from '../SettingsTab'

vi.mock('../AppPortSettingRow', () => ({ AppPortSettingRow: () => null }))
vi.mock('../CatalogSettingRow', () => ({ CatalogSettingRow: () => <div>catalog</div> }))
vi.mock('../StackDetectionSettingRow', () => ({ StackDetectionSettingRow: () => <div>stacks</div> }))
vi.mock('../CullingModelsSection', () => ({ CullingModelsSection: () => <div>culling models</div> }))
vi.mock('../LightroomWritebackSection', () => ({ LightroomWritebackSection: () => <div>lightroom write-back</div> }))
vi.mock('../AboutSection', () => ({ AboutSection: () => <div>about</div> }))
vi.mock('../DeleteAllDataSection', () => ({ DeleteAllDataSection: () => <div>delete all data</div> }))

describe('SettingsTab', () => {
  it('puts Culling between the general settings and Lightroom write-back', () => {
    render(<SettingsTab />)
    const order = ['catalog', 'stacks', 'culling models', 'lightroom write-back'].map((t) =>
      screen.getByText(t),
    )
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })
})
