/**
 * The `fixer` program; `bin.ts` is the executable that calls it.
 *
 * Every failure leaves as `Error: …` on stdout and exit 1 (not stderr) — scripts
 * read stdout for errors.
 */
import { config as runtimeConfig, loadLibraryConfig, type LibraryConfig } from '../config.js';
import { CliError } from './library-db.js';
import { helpText, parseArgv, preparseConfigPath, UsageError } from './parse.js';
import { COMMANDS, type CommandContext } from './registry.js';

export interface RunOptions {
  /** Where output goes. Defaults to stdout; tests pass a collector. */
  out?: (line: string) => void;
  /** Config already loaded, for a caller that has one. */
  config?: LibraryConfig;
}

/** Run one command line and return its exit code. */
export async function run(argv: readonly string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  let config: LibraryConfig;
  try {
    config =
      opts.config ??
      loadLibraryConfig(preparseConfigPath(argv, runtimeConfig.LT_CONFIG_YAML));
  } catch (e) {
    out(`Error loading config: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let args;
  try {
    args = parseArgv(argv, COMMANDS);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out(helpText(COMMANDS));
    return 1;
  }

  const command = COMMANDS.find((c) => c.name === args.command)!;
  const ctx: CommandContext = { args, config, out };
  try {
    return await command.handler(ctx);
  } catch (e) {
    out(`Error: ${e instanceof CliError || e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
