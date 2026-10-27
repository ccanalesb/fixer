/**
 * Flag parsing and help for the `fixer` CLI.
 *
 * Hand-rolled: subcommand-local flags override globals with the same name — see
 * `resolveFlag`.
 */

/** What a flag carries. `boolean` flags are switches; the rest take a value. */
export type FlagKind = 'string' | 'int' | 'boolean';

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  help: string;
  /** Single-letter alias, e.g. `-d` for `--db`. Global flags only. */
  short?: string;
  /** Rejects a value outside this set. */
  choices?: readonly string[];
  required?: boolean;
}

/**
 * Flags accepted before the subcommand.
 *
 * `resolveFlag` reads the subcommand's value first, then the global, so flags after
 * the subcommand win.
 */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'catalog', short: 'c', kind: 'string', help: 'Path to .lrcat file' },
  { name: 'db', short: 'd', kind: 'string', help: 'Path to SQLite database' },
  { name: 'config', kind: 'string', help: 'Path to config.yaml' },
  { name: 'workers', short: 'w', kind: 'int', help: 'Parallel workers (default: 4)' },
  { name: 'ai-model', kind: 'string', help: 'AI model for classification' },
  { name: 'skip-ai', kind: 'boolean', help: 'Skip AI classification' },
  { name: 'verbose', short: 'v', kind: 'boolean', help: 'Enable verbose output' },
  { name: 'limit', short: 'l', kind: 'int', help: 'Limit results' },
];

/** Parsed flag values, keyed by flag name with the leading dashes removed. */
export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface ParsedArgs {
  command: string;
  global: FlagValues;
  local: FlagValues;
}

/** Raised for a malformed command line; the caller prints help and exits 1. */
export class UsageError extends Error {}

/** A flag's value: subcommand-local wins over global. */
export function resolveFlag(args: ParsedArgs, name: string): string | number | boolean | undefined {
  return args.local[name] ?? args.global[name];
}

export function stringFlag(args: ParsedArgs, name: string): string | null {
  const value = resolveFlag(args, name);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function intFlag(args: ParsedArgs, name: string): number | null {
  const value = resolveFlag(args, name);
  return typeof value === 'number' ? value : null;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return resolveFlag(args, name) === true;
}

/** `--config` alone, read before the config file it names has been loaded. */
export function preparseConfigPath(argv: readonly string[], fallback: string): string {
  const at = argv.indexOf('--config');
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1]!;
  const inline = argv.find((a) => a.startsWith('--config='));
  return inline === undefined ? fallback : inline.slice('--config='.length);
}

interface FlagLookup {
  byName: Map<string, FlagSpec>;
  byShort: Map<string, FlagSpec>;
}

function lookup(specs: readonly FlagSpec[]): FlagLookup {
  return {
    byName: new Map(specs.map((s) => [s.name, s])),
    byShort: new Map(specs.filter((s) => s.short).map((s) => [s.short!, s])),
  };
}

/**
 * Split `argv` at the first bare word (the subcommand). Tokens before it are global
 * flags; tokens after are subcommand flags.
 */
export function parseArgv(
  argv: readonly string[],
  commands: readonly { name: string; flags: readonly FlagSpec[] }[],
): ParsedArgs {
  const globals = lookup(GLOBAL_FLAGS);
  const globalValues: FlagValues = {};

  let i = 0;
  for (; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-')) break;
    i = consumeFlag(argv, i, globals, globalValues);
  }

  const name = argv[i];
  if (name === undefined) throw new UsageError('no command given');
  const command = commands.find((c) => c.name === name);
  if (command === undefined) throw new UsageError(`unknown command: ${name}`);

  const locals = lookup(command.flags);
  const localValues: FlagValues = {};
  for (let j = i + 1; j < argv.length; j += 1) {
    const token = argv[j]!;
    if (!token.startsWith('-')) throw new UsageError(`unexpected argument: ${token}`);
    j = consumeFlag(argv, j, locals, localValues);
  }

  for (const spec of command.flags) {
    if (spec.required === true && localValues[spec.name] === undefined) {
      throw new UsageError(`the following arguments are required: --${spec.name}`);
    }
  }

  return { command: name, global: globalValues, local: localValues };
}

/** Read one flag at `index`, write it into `out`, return the last index consumed. */
function consumeFlag(
  argv: readonly string[],
  index: number,
  specs: FlagLookup,
  out: FlagValues,
): number {
  const token = argv[index]!;
  const eq = token.indexOf('=');
  const head = eq >= 0 ? token.slice(0, eq) : token;
  const inline = eq >= 0 ? token.slice(eq + 1) : null;

  const spec = head.startsWith('--')
    ? specs.byName.get(head.slice(2))
    : specs.byShort.get(head.slice(1));
  if (spec === undefined) throw new UsageError(`unrecognized arguments: ${head}`);

  if (spec.kind === 'boolean') {
    if (inline !== null) throw new UsageError(`--${spec.name} takes no value`);
    out[spec.name] = true;
    return index;
  }

  const raw = inline ?? argv[index + 1];
  if (raw === undefined || (inline === null && raw.startsWith('-'))) {
    throw new UsageError(`argument ${head}: expected one argument`);
  }

  if (spec.kind === 'int') {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      throw new UsageError(`argument ${head}: invalid int value: '${raw}'`);
    }
    out[spec.name] = n;
  } else {
    if (spec.choices && !spec.choices.includes(raw)) {
      throw new UsageError(
        `argument ${head}: invalid choice: '${raw}' (choose from ${spec.choices
          .map((c) => `'${c}'`)
          .join(', ')})`,
      );
    }
    out[spec.name] = raw;
  }
  return inline === null ? index + 1 : index;
}

/** The `--help` text. */
export function helpText(commands: readonly { name: string; help: string }[]): string {
  const flagLine = (s: FlagSpec): string => {
    const names = s.short === undefined ? `--${s.name}` : `--${s.name}, -${s.short}`;
    return `  ${names.padEnd(22)}${s.help}`;
  };
  return [
    'usage: fixer [options] <command> [options]',
    '',
    'Read Lightroom Classic catalog, index metadata, store in SQLite',
    '',
    'commands:',
    ...commands.map((c) => `  ${c.name.padEnd(22)}${c.help}`),
    '',
    'options:',
    ...GLOBAL_FLAGS.map(flagLine),
    '',
  ].join('\n');
}
