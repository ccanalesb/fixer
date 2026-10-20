/** CSS class for a dimension cell when the answer is in a failing band (F21). */
export function failingLevelClass(fails: boolean): string {
  return fails ? 'text-warning font-semibold' : ''
}
