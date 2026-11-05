/**
 * Sent-by-hand is read from user actions only; the verdict column can be stale.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { isCullCatalogPhoto, getCullReviewSummary } from '../src/db/library/cull-review.js';
import { upsertCullVerdict, type CullVerdictInput } from '../src/db/library/cull-verdicts.js';
import { recordCullUserAction } from '../src/db/library/cull-user-actions.js';
import { isSentByHand } from '../src/db/library/sent-by-hand.js';
import { isPhotoFilteredAndNotSentByHand } from '../src/db/library/cull-verdicts.js';
import { decideWriteback } from '../src/lightroom/writeback-decision.js';
import { getLrWritebackSettings, patchLrWritebackSettings } from '../src/db/library/lr-writeback-settings.js';
import { dropFilteredPhotosFromDescribeAndScoringSelection } from '../src/jobs/handlers/common.js';
import { LibraryFixture } from './helpers/library-fixture.js';
import { seedCullingStagesOn } from './helpers/culling-stages.js';

const KEY = 'mismatch-hand';
const app = createApp();

let fx: LibraryFixture;

function openLib(): Database.Database {
  return new Database(fx.dbPath);
}

function filteredVerdict(imageKey: string): CullVerdictInput {
  return {
    imageKey,
    verdict: 'filtered',
    filteredBy: 'culling_profile',
    filteredByStageKey: 'culling_profile:default:7',
    cullingProfileVerdict: 'filtered',
    sentByHand: false,
    pendingStages: [],
    pendingReason: '',
    scoreForecastOff: false,
    scoreForecastP8: null,
    pipelineSettingVersion: 1,
    stageVersionIds: [],
    runId: null,
  };
}

/** User action present; legacy `cull_verdicts.sent_by_hand` column cleared. */
function seedActionWithColumnZero(): void {
  const db = openLib();
  seedCullingStagesOn(db);
  upsertCullVerdict(db, filteredVerdict(KEY));
  recordCullUserAction(db, KEY, 'sent_by_hand');
  db.prepare(`UPDATE cull_verdicts SET sent_by_hand = 0, verdict = 'filtered', filtered_by = 'culling_profile' WHERE image_key = ?`).run(
    KEY,
  );
  db.close();
}

beforeEach(() => {
  fx = new LibraryFixture().seedFactoryDefaults().activate();
  fx.addImages(KEY);
  seedActionWithColumnZero();
});

afterEach(() => {
  fx.cleanup();
});

describe('sent_by_hand from actions when verdict column is 0', () => {
  it('counts as sent by hand for catalog, review, describe selection, and write-back', async () => {
    const db = openLib();
    expect(isSentByHand(db, KEY)).toBe(true);
    expect(isCullCatalogPhoto(db, KEY)).toBe(true);
    expect(isPhotoFilteredAndNotSentByHand(db, KEY)).toBe(false);
    const summary = getCullReviewSummary(db);
    expect(summary.sent_manually_count).toBeGreaterThanOrEqual(1);
    const { kept } = dropFilteredPhotosFromDescribeAndScoringSelection(db, [[KEY, 'catalog']]);
    expect(kept).toEqual([[KEY, 'catalog']]);
    patchLrWritebackSettings(db, { write_reject: true, write_stars: false });
    expect(decideWriteback(db, getLrWritebackSettings(db), KEY, null).reject).toEqual({
      want: false,
      why: 'sent_by_hand',
    });
    db.close();

    const res = await app.request(`/api/cull/photos/${KEY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent_by_hand: boolean };
    expect(body.sent_by_hand).toBe(true);
  });
});
