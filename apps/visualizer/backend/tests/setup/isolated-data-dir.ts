/**
 * With no `LT_DATA_DIR`, config.yaml, library.db, visualizer.db and providers.json
 * default to the repo root, which in a source install is the user's real library.
 * Every test file starts from an empty data folder instead; a test that needs the
 * repo-root defaults unsets it itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LT_DATA_DIR = mkdtempSync(join(tmpdir(), 'lt-test-data-'));
