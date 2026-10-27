#!/usr/bin/env node
/**
 * The `fixer` executable. Everything it does lives in `main.ts`, so
 * that tests can call `run` without a subprocess and without this file's
 * `process.exitCode` side effect.
 */
import { run } from './main.js';

process.exitCode = await run(process.argv.slice(2));
