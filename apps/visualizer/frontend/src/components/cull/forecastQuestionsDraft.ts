import type { ScoreForecastQuestion } from '../../services/api'

export const LEVELS_PER_QUESTION = 10

/** A question being edited; `id` stays '' until its first save, `key` tells drafts apart until then. */
export interface DraftQuestion extends ScoreForecastQuestion {
  key: string
}

let nextKey = 0

export const toDraft = (questions: ScoreForecastQuestion[]): DraftQuestion[] =>
  questions.map((q) => ({ ...q, key: q.id }))

export const newDraftQuestion = (name: string): DraftQuestion => ({
  key: `new-${++nextKey}`,
  id: '',
  name,
  perspective_slug: null,
  instructions: '',
  levels: Array.from({ length: LEVELS_PER_QUESTION }, () => ''),
  optional: false,
  applies: null,
})

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A new question's id: its perspective's slug, else its name's; fixed once saved. */
export function withIds(draft: DraftQuestion[]): DraftQuestion[] {
  const taken = new Set(draft.filter((q) => q.id).map((q) => q.id))
  return draft.map((q) => {
    if (q.id) return q
    const base = q.perspective_slug ?? (slugify(q.name) || 'question')
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return { ...q, id }
  })
}

/** What is saved: no draft keys, and "applies?" only on an optional question. */
export const toSaved = (draft: DraftQuestion[]): ScoreForecastQuestion[] =>
  draft.map((q) => ({
    id: q.id,
    name: q.name,
    perspective_slug: q.perspective_slug,
    instructions: q.instructions,
    levels: q.levels,
    optional: q.optional,
    applies: q.optional ? (q.applies ?? '') : null,
  }))

export const draftChanged = (draft: DraftQuestion[], saved: ScoreForecastQuestion[]) =>
  JSON.stringify(toSaved(draft)) !== JSON.stringify(toSaved(toDraft(saved)))

export const emptyLevels = (q: DraftQuestion) => q.levels.filter((l) => !l.trim()).length
