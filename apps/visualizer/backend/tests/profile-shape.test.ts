import { describe, expect, it } from 'vitest';
import { bandsField, levelTextField, validateProfileShape } from '../src/cull/profile-shape.js';
import type { ProfileDefinition, ProfileRule } from '../src/cull/types.js';

const definition = (levels: Record<string, string[]>): ProfileDefinition => ({
  dimensions: [
    { slug: 'a', name: 'A', question: 'qa' },
    { slug: 'b', name: 'B', question: 'qb' },
  ],
  level_sets: [{ id: '3', levels }],
});
const rule = (fails: number, strong: number): ProfileRule => ({
  level_sets: { '3': { fails_at_most: fails, strong_at_least: strong } },
  combine: 'every',
  filter_rule: { type: 'mean_fail' },
});
const full = { a: ['a1', 'a2', 'a3'], b: ['b1', 'b2', 'b3'] };

describe('validateProfileShape', () => {
  it('accepts a scale whose bands fit', () => {
    expect(validateProfileShape(definition(full), rule(1, 3), { requireText: true })).toEqual([]);
  });

  it('flags empty level texts by set, dimension and index only when text is required', () => {
    const def = definition({ a: ['a1', ' ', 'a3'], b: ['b1', 'b2', 'b3'] });
    expect(validateProfileShape(def, rule(1, 3), { requireText: false })).toEqual([]);
    const errors = validateProfileShape(def, rule(1, 3), { requireText: true });
    expect(errors.map((e) => e.field)).toEqual([levelTextField('3', 'a', 1)]);
  });

  it('flags dimensions with different level counts in one set', () => {
    const errors = validateProfileShape(definition({ a: ['a1', 'a2', 'a3'], b: ['b1', 'b2'] }), rule(1, 2), {
      requireText: true,
    });
    expect(errors.some((e) => e.field === bandsField('3') && /B has 2 levels/.test(e.message))).toBe(true);
  });

  it('flags strong past the top level and overlapping bands', () => {
    const tooHigh = validateProfileShape(definition(full), rule(1, 4), { requireText: true });
    expect(tooHigh.map((e) => e.message)).toEqual([
      'Level set 3: strong at ≥ 4 but there are only 3 levels — nothing can be strong.',
    ]);
    const overlap = validateProfileShape(definition(full), rule(2, 2), { requireText: true });
    expect(overlap.map((e) => e.message)).toEqual(['Level set 3: fails and strong overlap.']);
  });

  it('flags missing bands and bands for a set that does not exist', () => {
    const r: ProfileRule = { ...rule(1, 3), level_sets: { '9': { fails_at_most: 1, strong_at_least: 2 } } };
    const fields = validateProfileShape(definition(full), r, { requireText: true }).map((e) => e.field);
    expect(fields).toEqual([bandsField('3'), bandsField('9')]);
  });
});
