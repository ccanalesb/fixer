/** CSS class for a dimension cell when the answer is in a failing band (F21). */
export function failingLevelClass(fails: boolean): string {
  return fails ? 'text-warning font-semibold' : ''
}

/** Failing and strong answers both highlighted, for photos that passed. */
export function passedLevelClass(level: { fails: boolean; strong: boolean } | undefined): string {
  if (level?.fails) return failingLevelClass(true)
  return level?.strong ? 'text-success font-semibold' : ''
}
