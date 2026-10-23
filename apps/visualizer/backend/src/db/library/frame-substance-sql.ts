/**
 * The one SQL phrasing of "this frame is condemned".
 *
 * A leaf module on purpose: the identity ranking, stack suggestions and the catalog
 * listing all need this fragment and sit on both sides of `frame_substance`'s own
 * imports, so anything with dependencies here would close an import cycle.
 */

export const FLAGGED_VERDICTS = ['void', 'illegible'] as const;

/**
 * SQL for "this frame is condemned and the user has not overridden it".
 *
 * Four read paths express this rule — the identity ranking's scores base query,
 * pending stack suggestions (which matches either end of a pair), and the catalog
 * listing's `flagged` filter in both directions. They must not be able to disagree,
 * so they all render it from here.
 */
export function flaggedExistsSql(...imageKeyColumns: string[]): string {
  const match =
    imageKeyColumns.length === 1
      ? `fs.image_key = ${imageKeyColumns[0]}`
      : `fs.image_key IN (${imageKeyColumns.join(', ')})`;
  return `
        EXISTS (
            SELECT 1
            FROM image_frame_substance fs
            WHERE ${match}
              AND fs.verdict IN ('void', 'illegible')
              AND NOT EXISTS (
                  SELECT 1
                  FROM frame_substance_overrides o
                  WHERE o.image_key = fs.image_key
              )
        )
    `;
}
