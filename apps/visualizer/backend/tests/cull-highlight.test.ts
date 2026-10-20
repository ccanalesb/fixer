/**
 * Failing-band highlights follow levelSetReadout (F21: any dimension in fail band).
 */
import { describe, expect, it } from 'vitest';
import { levelSetReadout } from '../src/cull/decide.js';

describe('levelSetReadout highlights', () => {
  it('marks every dimension at or below fails_at_most', () => {
    const answers = {
      a: [0, 0, 1, 0, 0],
      b: [0, 0, 0, 1, 0],
    };
    const readout = levelSetReadout(answers, { fails_at_most: 3, strong_at_least: 5 });
    expect(readout.a!.fails).toBe(true);
    expect(readout.b!.fails).toBe(false);
  });
});
