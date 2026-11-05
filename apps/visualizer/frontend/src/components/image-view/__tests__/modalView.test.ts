import { describe, it, expect } from 'vitest'
import { modalPropsFor } from '../modalView'

describe('modalPropsFor', () => {
  it('culling view opens on Culling with cull section and catalog primary score', () => {
    expect(modalPropsFor('culling')).toEqual({
      initialTab: 'culling',
      showCullSection: true,
      primaryScoreSource: 'catalog',
    })
  })

  it('catalog view opens on File without cull section', () => {
    expect(modalPropsFor('catalog')).toEqual({
      initialTab: 'file',
      showCullSection: false,
      primaryScoreSource: 'catalog',
    })
  })

  it('identity view opens on AI with identity primary score', () => {
    expect(modalPropsFor('identity')).toEqual({
      initialTab: 'ai',
      showCullSection: false,
      primaryScoreSource: 'identity',
    })
  })
})
