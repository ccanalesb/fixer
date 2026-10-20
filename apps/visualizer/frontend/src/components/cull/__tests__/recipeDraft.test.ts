import { describe, expect, it } from 'vitest'
import {
  addLevelSet,
  bandProblems,
  emptyLevelCount,
  insertLevel,
  levelCount,
  newLevelSetProblem,
  removeLevel,
  removeLevelSet,
  type RecipeDraft,
} from '../recipeDraft'

const draft: RecipeDraft = {
  definition: {
    dimensions: [
      { slug: 'a', name: 'A', question: 'qa' },
      { slug: 'b', name: 'B', question: 'qb' },
    ],
    level_sets: [{ id: '3', levels: { a: ['a1', 'a2', 'a3'], b: ['b1', 'b2', 'b3'] } }],
  },
  rule: {
    level_sets: { '3': { fails_at_most: 1, strong_at_least: 3 } },
    combine: 'every',
    cut_rule: { type: 'mean_fail' },
  },
}

describe('recipeDraft', () => {
  it('inserts a level in every dimension at the given index', () => {
    const next = insertLevel(draft, '3', 1, { a: 'aX', b: 'bX' })
    expect(next.definition.level_sets[0]!.levels).toEqual({ a: ['a1', 'aX', 'a2', 'a3'], b: ['b1', 'bX', 'b2', 'b3'] })
    expect(levelCount(next, '3')).toBe(4)
    expect(draft.definition.level_sets[0]!.levels.a).toHaveLength(3)
  })

  it('removes a level from every dimension but keeps at least two', () => {
    const two = removeLevel(draft, '3', 2)
    expect(two.definition.level_sets[0]!.levels).toEqual({ a: ['a1', 'a2'], b: ['b1', 'b2'] })
    expect(removeLevel(two, '3', 0)).toBe(two)
  })

  it('names a new set by its level count and copies texts trimmed or padded', () => {
    expect(newLevelSetProblem(draft, 3)).toBe('There is already a level set 3.')
    expect(newLevelSetProblem(draft, 1)).toMatch(/^Between 2 and 15/)
    const next = addLevelSet(draft, 5, '3')
    const set = next.definition.level_sets.find((s) => s.id === '5')!
    expect(set.levels.a).toEqual(['a1', 'a2', 'a3', '', ''])
    expect(next.rule.level_sets['5']).toEqual({ fails_at_most: 2, strong_at_least: 4 })
    expect(emptyLevelCount(next, '5')).toBe(4)
    expect(emptyLevelCount(next, '5', 'b')).toBe(2)
  })

  it('removes a set with its bands, never the last one', () => {
    const two = addLevelSet(draft, 2, null)
    const back = removeLevelSet(two, '2')
    expect(back.definition.level_sets.map((s) => s.id)).toEqual(['3'])
    expect(Object.keys(back.rule.level_sets)).toEqual(['3'])
    expect(removeLevelSet(back, '3')).toBe(back)
  })

  it('reports bands that cover nothing or overlap', () => {
    expect(bandProblems(draft)).toEqual([])
    const shrunk = removeLevel(draft, '3', 2)
    expect(bandProblems(shrunk).map((p) => p.message)).toEqual([
      'Level set 3: strong at ≥ 3 but there are only 2 levels — nothing can be strong.',
    ])
  })
})
