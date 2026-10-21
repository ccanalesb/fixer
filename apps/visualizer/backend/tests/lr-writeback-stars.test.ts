/**
 * Strong-dimension counting → star rating for Lightroom write-back.
 */
import { describe, expect, it } from 'vitest';
import {
  countStrongDimensions,
  ratingFromStrongCount,
  type StarsStrongFrom,
} from '../src/lightroom/writeback-stars.js';
import type { ProfileDefinition, ProfileRule, StageAnswers } from '../src/cull/types.js';

const definition: ProfileDefinition = {
  dimensions: [
    { slug: 'a', name: 'A', question: 'Q' },
    { slug: 'b', name: 'B', question: 'Q' },
    { slug: 'c', name: 'C', question: 'Q' },
  ],
  level_sets: [
    { id: '7', levels: { a: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], b: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'], c: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'] } },
    { id: '10', levels: { a: Array(10).fill('x'), b: Array(10).fill('x'), c: Array(10).fill('x') } },
  ],
};

const rule: ProfileRule = {
  level_sets: {
    '7': { fails_at_most: 2, strong_at_least: 6 },
    '10': { fails_at_most: 3, strong_at_least: 8 },
  },
  combine: 'every',
  filter_rule: { type: 'all_fail', dimensions: ['a'] },
  stars_strong_from: 'every',
};

function answers(levelSet: string, dim: string, levelIndex: number): StageAnswers {
  const n = levelSet === '7' ? 7 : 10;
  const v = Array<number>(n).fill(0);
  v[levelIndex] = 1;
  return { [`${levelSet}|${dim}`]: v };
}

function merge(...parts: StageAnswers[]): StageAnswers {
  return Object.assign({}, ...parts);
}

describe('ratingFromStrongCount', () => {
  it('maps 0/1/2/3+ to null/1/2/3', () => {
    expect(ratingFromStrongCount(0)).toBeNull();
    expect(ratingFromStrongCount(1)).toBe(1);
    expect(ratingFromStrongCount(2)).toBe(2);
    expect(ratingFromStrongCount(3)).toBe(3);
    expect(ratingFromStrongCount(9)).toBe(3);
  });
});

describe('countStrongDimensions', () => {
  const modes: StarsStrongFrom[] = ['7', '10', 'every', 'any'];

  it('returns 0 when answers are missing', () => {
    for (const mode of modes) {
      expect(countStrongDimensions(definition, { ...rule, stars_strong_from: mode }, {}, 'profile')).toBe(0);
    }
  });

  it('counts strong when answers use dimension slugs (stored job shape)', () => {
    const qidAnswers = answers('7', 'a', 5);
    const byStage = {
      'culling_profile:profile:7': { a: qidAnswers['7|a']! },
    };
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: '7' }, byStage, 'profile')).toBe(1);
  });

  it('counts strong at 7-level set only', () => {
    const byStage = {
      'culling_profile:profile:7': merge(
        answers('7', 'a', 5),
        answers('7', 'b', 5),
        answers('7', 'c', 0),
      ),
    };
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: '7' }, byStage, 'profile')).toBe(2);
  });

  it('counts strong at 10-level set only', () => {
    const byStage = {
      'culling_profile:profile:10': merge(answers('10', 'a', 9), answers('10', 'b', 0), answers('10', 'c', 9)),
    };
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: '10' }, byStage, 'profile')).toBe(2);
  });

  it('every requires strong in all level sets per dimension', () => {
    const byStage = {
      'culling_profile:profile:7': merge(answers('7', 'a', 6), answers('7', 'b', 6)),
      'culling_profile:profile:10': merge(answers('10', 'a', 6), answers('10', 'b', 6)),
    };
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: 'every' }, byStage, 'profile')).toBe(0);
    byStage['culling_profile:profile:10'] = merge(answers('10', 'a', 9), answers('10', 'b', 9));
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: 'every' }, byStage, 'profile')).toBe(2);
  });

  it('any requires strong in at least one level set per dimension', () => {
    const byStage = {
      'culling_profile:profile:7': merge(answers('7', 'a', 6), answers('7', 'b', 0)),
      'culling_profile:profile:10': merge(answers('10', 'a', 0), answers('10', 'b', 0)),
    };
    expect(countStrongDimensions(definition, { ...rule, stars_strong_from: 'any' }, byStage, 'profile')).toBe(1);
  });
});
