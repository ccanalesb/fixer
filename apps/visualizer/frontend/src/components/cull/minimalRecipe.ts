/** F19 / ruling 8=A — one dimension, one level set, five empty level texts. */
export function minimalNewRecipeBody(slug: string, name: string) {
  return {
    slug,
    name,
    model: 'laya-base',
    definition: {
      dimensions: [{ slug: 'dimension-1', name: 'Dimension 1', question: '' }],
      level_sets: [{ id: '5', levels: { 'dimension-1': ['', '', '', '', ''] } }],
    },
    rule: {
      level_sets: { '5': { fails_at_most: 2, strong_at_least: 4 } },
      combine: 'any' as const,
      cut_rule: { type: 'all_fail' as const, dimensions: ['dimension-1'] },
    },
    active: false,
  }
}
