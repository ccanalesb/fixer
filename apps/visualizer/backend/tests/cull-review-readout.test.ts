/**
 * Profile row readout maps question ids to dimension fail bands.
 */
import { describe, expect, it } from 'vitest';
import { buildProfileRowReadout } from '../src/cull/review.js';
import type { ProfileDefinition, ProfileRule } from '../src/cull/types.js';
import type { CullProfile } from '../src/db/library/cull-profiles.js';

const definition: ProfileDefinition = {
  dimensions: [
    { slug: 'immediate-impact', name: 'Immediate impact', question: 'Q' },
    { slug: 'connotation', name: 'Connotation', question: 'Q' },
  ],
  level_sets: [{ id: '7', levels: { 'immediate-impact': ['a', 'b', 'c', 'd', 'e', 'f', 'g'], connotation: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }],
};

const rule: ProfileRule = {
  level_sets: { '7': { fails_at_most: 2, strong_at_least: 5 } },
  combine: 'any',
  filter_rule: { type: 'all_fail', dimensions: ['immediate-impact'] },
};

const profile = {
  slug: 'default',
  name: 'Default culling profile',
  definition,
  rule,
} as CullProfile;

describe('buildProfileRowReadout', () => {
  it('marks fails when stored answers use levelSet|dimension qids', () => {
    const stageKey = 'culling_profile:default:7';
    const answersByStage = {
      [stageKey]: {
        '7|immediate-impact': [0, 1, 0, 0, 0, 0, 0],
        '7|connotation': [0, 0, 1, 0, 0, 0, 0],
      },
    };
    const readout = buildProfileRowReadout(profile, definition, rule, answersByStage);
    const dim = readout.level_sets[0]!.dimensions.find((d) => d.slug === 'immediate-impact')!;
    expect(dim.levels[0]!.level).toBe(2);
    expect(dim.levels[0]!.fails).toBe(true);
  });
});
