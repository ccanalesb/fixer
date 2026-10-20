import type { CullRecipeDetail } from '../../services/api'

export type RecipeDraft = Pick<CullRecipeDetail, 'definition' | 'rule'>
type Bands = CullRecipeDetail['rule']['level_sets'][string]

export const MIN_LEVELS_PER_SET = 2
export const MAX_LEVELS_PER_SET = 15

export function levelCount(draft: RecipeDraft, setId: string): number {
  const set = draft.definition.level_sets.find((s) => s.id === setId)
  const first = draft.definition.dimensions[0]?.slug
  return set && first ? (set.levels[first]?.length ?? 0) : 0
}

function mapSet<T extends RecipeDraft>(
  draft: T,
  setId: string,
  fn: (levels: Record<string, string[]>) => Record<string, string[]>,
): T {
  return {
    ...draft,
    definition: {
      ...draft.definition,
      level_sets: draft.definition.level_sets.map((s) => (s.id === setId ? { ...s, levels: fn(s.levels) } : s)),
    },
  }
}

/** Insert one level at `index` (0 = lowest) in every dimension of the set. */
export function insertLevel<T extends RecipeDraft>(
  draft: T,
  setId: string,
  index: number,
  texts: Record<string, string>,
): T {
  return mapSet(draft, setId, (levels) => {
    const next: Record<string, string[]> = {}
    for (const dim of draft.definition.dimensions) {
      const cur = [...(levels[dim.slug] ?? [])]
      cur.splice(index, 0, texts[dim.slug] ?? '')
      next[dim.slug] = cur
    }
    return next
  })
}

/** Remove the level at `index` from every dimension; a set keeps at least MIN_LEVELS_PER_SET. */
export function removeLevel<T extends RecipeDraft>(draft: T, setId: string, index: number): T {
  if (levelCount(draft, setId) <= MIN_LEVELS_PER_SET) return draft
  return mapSet(draft, setId, (levels) => {
    const next: Record<string, string[]> = {}
    for (const dim of draft.definition.dimensions) {
      next[dim.slug] = (levels[dim.slug] ?? []).filter((_, i) => i !== index)
    }
    return next
  })
}

export function setLevelText<T extends RecipeDraft>(
  draft: T,
  setId: string,
  dimSlug: string,
  index: number,
  text: string,
): T {
  return mapSet(draft, setId, (levels) => {
    const cur = [...(levels[dimSlug] ?? [])]
    cur[index] = text
    return { ...levels, [dimSlug]: cur }
  })
}

export function setBands<T extends RecipeDraft>(draft: T, setId: string, bands: Bands): T {
  return { ...draft, rule: { ...draft.rule, level_sets: { ...draft.rule.level_sets, [setId]: bands } } }
}

/** Why a new set of `count` levels cannot be created, or null. Sets are named by their level count. */
export function newLevelSetProblem(draft: RecipeDraft, count: number): string | null {
  if (!Number.isInteger(count) || count < MIN_LEVELS_PER_SET || count > MAX_LEVELS_PER_SET) {
    return `Between ${MIN_LEVELS_PER_SET} and ${MAX_LEVELS_PER_SET} levels.`
  }
  if (draft.definition.level_sets.some((s) => s.id === String(count))) {
    return `There is already a level set ${count}.`
  }
  return null
}

/** New set named by its level count; copied from `fromId` (trimmed or padded) or empty. */
export function addLevelSet<T extends RecipeDraft>(draft: T, count: number, fromId: string | null): T {
  const id = String(count)
  const src = fromId ? draft.definition.level_sets.find((s) => s.id === fromId) : undefined
  const levels: Record<string, string[]> = {}
  for (const dim of draft.definition.dimensions) {
    const base = (src?.levels[dim.slug] ?? []).slice(0, count)
    while (base.length < count) base.push('')
    levels[dim.slug] = base
  }
  return {
    ...draft,
    definition: { ...draft.definition, level_sets: [...draft.definition.level_sets, { id, levels }] },
    rule: {
      ...draft.rule,
      level_sets: {
        ...draft.rule.level_sets,
        [id]: { fails_at_most: Math.max(1, Math.round(count * 0.4)), strong_at_least: Math.max(2, count - 1) },
      },
    },
  }
}

/** The last level set cannot be removed. */
export function removeLevelSet<T extends RecipeDraft>(draft: T, setId: string): T {
  if (draft.definition.level_sets.length <= 1) return draft
  const bands = { ...draft.rule.level_sets }
  delete bands[setId]
  return {
    ...draft,
    definition: { ...draft.definition, level_sets: draft.definition.level_sets.filter((s) => s.id !== setId) },
    rule: { ...draft.rule, level_sets: bands },
  }
}

export function emptyLevelCount(draft: RecipeDraft, setId?: string, dimSlug?: string): number {
  let n = 0
  for (const set of draft.definition.level_sets) {
    if (setId !== undefined && set.id !== setId) continue
    for (const dim of draft.definition.dimensions) {
      if (dimSlug !== undefined && dim.slug !== dimSlug) continue
      n += (set.levels[dim.slug] ?? []).filter((t) => !t.trim()).length
    }
  }
  return n
}

/** Same band checks the backend makes on save. */
export function bandProblems(draft: RecipeDraft): { setId: string; message: string }[] {
  const out: { setId: string; message: string }[] = []
  for (const set of draft.definition.level_sets) {
    const b = draft.rule.level_sets[set.id]
    const n = levelCount(draft, set.id)
    if (!b) {
      out.push({ setId: set.id, message: `Level set ${set.id} has no fails/strong bands.` })
      continue
    }
    if (b.fails_at_most < 1) out.push({ setId: set.id, message: `Level set ${set.id}: fails at must be at least 1.` })
    if (b.strong_at_least > n) {
      out.push({
        setId: set.id,
        message: `Level set ${set.id}: strong at ≥ ${b.strong_at_least} but there are only ${n} levels — nothing can be strong.`,
      })
    }
    if (b.fails_at_most >= b.strong_at_least) {
      out.push({ setId: set.id, message: `Level set ${set.id}: fails and strong overlap.` })
    }
  }
  return out
}
