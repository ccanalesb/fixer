/**
 * `enrich-catalog` — warm the vision cache.
 *
 * `--cache-only` and bare `enrich-catalog` both run cache warming. `--catalog`
 * (and `config.yaml`'s catalog when `--catalog` is omitted) choose which
 * library to open, the same as other commands. See `docs/plans/ts-backend-migration.md`.
 */
import { warmVisionCache } from '../../vision/vision-cache.js';
import { withLibraryDbAsync } from '../library-db.js';
import { intFlag } from '../parse.js';
import type { CommandContext } from '../registry.js';

export function cmdEnrichCatalog(ctx: CommandContext): Promise<number> {
  return withLibraryDbAsync(ctx, { mustExist: true }, async (db) => {
    const result = await warmVisionCache(db, intFlag(ctx.args, 'limit'));
    ctx.out(`Processed: ${result.processed}`);
    ctx.out(`Skipped: ${result.skipped}`);
    ctx.out(`Errors: ${result.errors}`);
    return 0;
  });
}
