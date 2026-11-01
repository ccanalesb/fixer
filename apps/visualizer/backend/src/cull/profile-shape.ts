/**
 * Structural checks on a culling profile: every level set has the same scale for
 * every dimension, and what counts as low and high fits that scale.
 */
import type { ProfileValidationError } from './profile-validate.js';
import type { ProfileDefinition, ProfileRule } from './types.js';

export const MIN_LEVELS_PER_SET = 2;

/** Field key for one level text: `${setId}|${dimSlug}|${levelIndex}`. */
export const levelTextField = (setId: string, dimSlug: string, index: number) => `${setId}|${dimSlug}|${index}`;
/** Field key for one level set's bands. */
export const bandsField = (setId: string) => `bands|${setId}`;

/**
 * `requireText` refuses empty level texts; off when creating the blank starter profile,
 * on whenever a definition is saved for the model to answer.
 */
export function validateProfileShape(
  definition: ProfileDefinition,
  rule: ProfileRule,
  opts: { requireText: boolean },
): ProfileValidationError[] {
  const errors: ProfileValidationError[] = [];
  const seen = new Set<string>();
  for (const set of definition.level_sets) {
    if (seen.has(set.id)) errors.push({ field: bandsField(set.id), message: `Level set ${set.id} appears twice.` });
    seen.add(set.id);
    let count: number | null = null;
    for (const dim of definition.dimensions) {
      const levels = set.levels[dim.slug] ?? [];
      if (count === null) count = levels.length;
      else if (levels.length !== count) {
        errors.push({
          field: bandsField(set.id),
          message: `Level set ${set.id}: ${dim.name} has ${levels.length} levels, the other dimensions ${count}.`,
        });
      }
      if (opts.requireText) {
        levels.forEach((text, i) => {
          if (!text.trim()) {
            errors.push({
              field: levelTextField(set.id, dim.slug, i),
              message: `Level set ${set.id}: level ${i + 1} of ${dim.name} is empty.`,
            });
          }
        });
      }
    }
    const n = count ?? 0;
    if (n < MIN_LEVELS_PER_SET) {
      errors.push({ field: bandsField(set.id), message: `Level set ${set.id} needs at least ${MIN_LEVELS_PER_SET} levels.` });
    }
    const bands = rule.level_sets[set.id];
    if (!bands) {
      errors.push({ field: bandsField(set.id), message: `The ${set.id}-level scale has no low and high levels.` });
      continue;
    }
    if (bands.fails_at_most < 1) {
      errors.push({ field: bandsField(set.id), message: `${set.id}-level scale: at least level 1 must count as low.` });
    }
    if (bands.strong_at_least > n) {
      errors.push({
        field: bandsField(set.id),
        message: `${set.id}-level scale: high starts at level ${bands.strong_at_least} but there are only ${n} levels — nothing can be high.`,
      });
    }
    if (bands.fails_at_most >= bands.strong_at_least) {
      errors.push({ field: bandsField(set.id), message: `${set.id}-level scale: low and high overlap.` });
    }
  }
  for (const id of Object.keys(rule.level_sets)) {
    if (!seen.has(id)) errors.push({ field: bandsField(id), message: `Bands for level set ${id}, which does not exist.` });
  }
  return errors;
}
