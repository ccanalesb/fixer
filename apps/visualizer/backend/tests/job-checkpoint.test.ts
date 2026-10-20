/**
 * Resume checkpoint fingerprints and canonical JSON.
 *
 * Golden digests must stay stable so jobs checkpointed before cutover can resume
 * without redoing work. Non-ASCII keys test legacy JSON escaping rules.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_VERSION,
  buildAnalyzeStagePayload,
  buildBatchDescribeCheckpointBody,
  buildBatchEmbedImageCheckpointBody,
  buildBatchScoreCheckpointBody,
  buildBatchStackDetectCheckpointBody,
  fingerprintBatchDescribe,
  fingerprintBatchEmbedImage,
  fingerprintBatchScore,
  fingerprintBatchStackDetect,
  fingerprintCatalogCacheBuild,
  loadResumeState,
  mergeDescribeScoreCullCheckpoint,
  persistAnalyzeStageCheckpoint,
  readAnalyzeCheckpoint,
  readDescribeScoreCullSubObject,
} from '../src/jobs/checkpoint.js';
import { canonicalJson } from '../src/utils/canonical-json.js';
import { CHECKPOINT_MAX_ENTRIES, buildBatchCullCheckpointBody } from '../src/jobs/checkpoint.js';

const MISMATCH = 'checkpoint mismatch: batch_describe fingerprint changed, starting fresh';

const loadPairs = (
  metadata: Record<string, unknown>,
  fingerprint: string,
  log: (m: string) => void = () => {},
): Set<string> =>
  loadResumeState({
    metadata,
    jobType: 'batch_describe',
    resumeKey: 'processed_pairs',
    fingerprint,
    mismatchMessage: MISMATCH,
    log,
  });

describe('canonicalJson', () => {
  it('sorts keys and escapes non-ASCII for stable digests', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ k: 'Café' })).toBe('{"k":"Caf\\u00e9"}');
    // Astral characters escape as a UTF-16 surrogate pair.
    expect(canonicalJson({ k: '\u{1F600}' })).toBe('{"k":"\\ud83d\\ude00"}');
  });
});

describe('fingerprintBatchDescribe', () => {
  it('matches golden digests for the same inputs', async () => {
    await expect(fingerprintBatchDescribe({}, [])).resolves.toBe(
      'a98980d082036758489667bce9bd2543b182f830b86d2c346ede5c837aabd241',
    );
    await expect(
      fingerprintBatchDescribe(
        { force: true, min_rating: '3', date_filter: '6months', max_workers: 8 },
        [
          ['2020-03-08__CC14833', 'catalog'],
          ['a', 'catalog'],
        ],
      ),
    ).resolves.toBe('774cea8be6bb652d121676c4b1a939833e553210d1925a23cdae9ef2cd7e371a');
    await expect(
      fingerprintBatchDescribe(
        {
          perspective_slugs: ['street', 'abstract'],
          provider_id: 'local',
          provider_model: 'vision-1',
          backfill_visual_tags: true,
        },
        [['k1', 'catalog']],
      ),
    ).resolves.toBe('8e6cd6e60ba2d432abfa049d1c1091c3000164b2f6e3f42be03f8628b5a7acf2');
    await expect(
      fingerprintBatchDescribe({ min_rating: 'not-a-number', perspective_slugs: [] }, [
        ['Café__ñ', 'catalog'],
        ['日本', 'catalog'],
      ]),
    ).resolves.toBe('f5e6d8bb6259ffe620b980287ff80eed0d2e60f88259004ce998c1ee333810b5');
  });

  it('changes when the work list changes', async () => {
    const a = await fingerprintBatchDescribe({}, [['k1', 'catalog']]);
    const b = await fingerprintBatchDescribe({}, [['k2', 'catalog']]);
    expect(a).not.toBe(b);
  });

  /** An empty list means "not specified", so it must not read as a distinct run. */
  it('treats an empty perspective_slugs list as absent', async () => {
    const empty = await fingerprintBatchDescribe({ perspective_slugs: [] }, []);
    const absent = await fingerprintBatchDescribe({}, []);
    expect(empty).toBe(absent);
  });
});

describe('fingerprintBatchScore', () => {
  it('matches golden digests for the same inputs', async () => {
    await expect(fingerprintBatchScore({}, [])).resolves.toBe(
      '698ef5bf0a43ef8cae2994b9c90fc124a05386f5a50d261becbb6a9ab0a3ddbd',
    );
    await expect(
      fingerprintBatchScore(
        { force: true, min_rating: '3', date_filter: '6months', max_workers: 8 },
        [
          ['2020-03-08__CC14833', 'catalog', 'street'],
          ['a', 'catalog', 'light'],
        ],
      ),
    ).resolves.toBe('e0766db72557cd90de18a3b25c4277a8c0495e0513c68a8462f6eb1ffcfff19b');
    await expect(
      fingerprintBatchScore(
        {
          perspective_slugs: ['street', 'abstract'],
          provider_id: 'local',
          provider_model: 'vision-1',
        },
        [['k1', 'catalog', 'street']],
      ),
    ).resolves.toBe('257d751ac6ba9059e42b0c9132ec9cddc3226a864cd96ea41ac15e36bec31804');
    await expect(
      fingerprintBatchScore({ min_rating: 'not-a-number', perspective_slugs: [] }, [
        ['Café__ñ', 'catalog', '日本'],
        ['日本', 'catalog', 'street'],
      ]),
    ).resolves.toBe('269d91af4c95a96f5554f99831886abaccca5528628c3e8755b90238c2157c61');
  });

  /**
   * The perspective is part of the unit, so activating a rubric mid-run is a
   * different run: the previous "done" set says nothing about the new slug.
   */
  it('changes when a perspective joins the work list', async () => {
    const one = await fingerprintBatchScore({}, [['k1', 'catalog', 'street']]);
    const two = await fingerprintBatchScore({}, [
      ['k1', 'catalog', 'street'],
      ['k1', 'catalog', 'light'],
    ]);
    expect(one).not.toBe(two);
  });

  it('does not depend on the order the triples arrive in', async () => {
    await expect(
      fingerprintBatchScore({}, [
        ['b', 'catalog', 'street'],
        ['a', 'catalog', 'light'],
      ]),
    ).resolves.toBe(
      await fingerprintBatchScore({}, [
        ['a', 'catalog', 'light'],
        ['b', 'catalog', 'street'],
      ]),
    );
  });
});

describe('fingerprintBatchEmbedImage', () => {
  const noWindow = { resolvedMonths: null, resolvedYear: null };

  it('matches golden digests for the same inputs', async () => {
    await expect(fingerprintBatchEmbedImage({}, [], noWindow)).resolves.toBe(
      'fe6a73865c32858e8090ded4f6fee96197abf1331225b5c850b6d6dfded8d9c6',
    );
    await expect(
      fingerprintBatchEmbedImage({ force: true, min_rating: '3' }, ['b', 'a'], {
        resolvedMonths: 6,
        resolvedYear: null,
      }),
    ).resolves.toBe('ef0759fe43429139bf2640ec1bb79e063405b655052b60f7693f3ebcfeeb6ed6');
    await expect(
      fingerprintBatchEmbedImage({ min_rating: 'not-a-number' }, ['Café__ñ', '日本'], {
        resolvedMonths: null,
        resolvedYear: '2024',
      }),
    ).resolves.toBe('b805ee423c6843488bb3152dd85b9d0c8fefde7896ce41cdfed0f0708d8ae062');
  });

  /**
   * The window is fingerprinted after resolution, so the several spellings of one
   * window do not each discard the previous run's checkpoint.
   */
  it('ignores how the date window was spelled, and notices when it changes', async () => {
    const sixMonths = { resolvedMonths: 6, resolvedYear: null };
    await expect(fingerprintBatchEmbedImage({ date_filter: '6months' }, ['a'], sixMonths)).resolves.toBe(
      await fingerprintBatchEmbedImage({ last_months: 6 }, ['a'], sixMonths),
    );
    await expect(fingerprintBatchEmbedImage({}, ['a'], sixMonths)).resolves.not.toBe(
      await fingerprintBatchEmbedImage({}, ['a'], { resolvedMonths: 3, resolvedYear: null }),
    );
  });

  it('does not depend on the order the work list arrives in', async () => {
    await expect(fingerprintBatchEmbedImage({}, ['b', 'a'], noWindow)).resolves.toBe(
      await fingerprintBatchEmbedImage({}, ['a', 'b'], noWindow),
    );
  });
});

describe('fingerprintBatchStackDetect', () => {
  it('matches golden digests for the same inputs', async () => {
    await expect(
      fingerprintBatchStackDetect([], { resolvedDeltaMs: 2000, forceMode: 'incremental' }),
    ).resolves.toBe('bb8c918ab959d1d0075e25ec09614709de73c034155294043e94ccc13e15e944');
    await expect(
      fingerprintBatchStackDetect(['b', 'a', 'c'], { resolvedDeltaMs: 1500, forceMode: 'full' }),
    ).resolves.toBe('984368b5ae78677b565122a56eca7a31bf358c57df7c21c8bf2b30181dbfa74a');
    await expect(
      fingerprintBatchStackDetect(['2024-01-01__café', 'z'], {
        resolvedDeltaMs: 2000,
        forceMode: 'preserve_edited',
      }),
    ).resolves.toBe('15f2b6ad444c54dfb06a96ac039e81742bf9c2b366e3424dfcb8463b74df33a1');
  });

  /**
   * Both are resolved rather than raw metadata: `delta_ms` falls back to
   * `config.yaml` and an absent `force` means incremental, so a run whose grouping
   * changed for either reason has to discard the checkpoint.
   */
  it('changes when the burst gap or the force mode does', async () => {
    const base = { resolvedDeltaMs: 2000, forceMode: 'incremental' };
    const baseline = await fingerprintBatchStackDetect(['a'], base);
    await expect(
      fingerprintBatchStackDetect(['a'], { ...base, resolvedDeltaMs: 2001 }),
    ).resolves.not.toBe(baseline);
    await expect(fingerprintBatchStackDetect(['a'], { ...base, forceMode: 'full' })).resolves.not.toBe(
      baseline,
    );
  });
});

describe('fingerprintCatalogCacheBuild', () => {
  it('matches golden digests for the same inputs', async () => {
    await expect(
      fingerprintCatalogCacheBuild({}, { resolvedMonths: null, resolvedYear: null }),
    ).resolves.toBe('d1437c4a9a2c7fa10220ee5189c20882b49cfcc145fd3ca3801af8f919f4247b');
    await expect(
      fingerprintCatalogCacheBuild(
        { force_embed: true, force_stack: 'preserve_edited', min_rating: '3', year: 2024 },
        { resolvedMonths: null, resolvedYear: '2024' },
      ),
    ).resolves.toBe('e5540856ed42be83e708a14e5014583d7bebdf47d30b556c854be7bad8ee3195');
    await expect(
      fingerprintCatalogCacheBuild(
        { last_months: 6, month: 'café' },
        { resolvedMonths: 6, resolvedYear: null },
      ),
    ).resolves.toBe('a44e5fec6a2f59207f1d75bcb9ea94c45946d8b1d4cdf98646b0a18457664d15');
  });

  /** force_stack modes collapse to a boolean "forcing was requested" in the fingerprint. */
  it('flattens the force flags to booleans', async () => {
    const window = { resolvedMonths: null, resolvedYear: null };
    await expect(fingerprintCatalogCacheBuild({ force_stack: true }, window)).resolves.toBe(
      await fingerprintCatalogCacheBuild({ force_stack: 'preserve_edited' }, window),
    );
    await expect(fingerprintCatalogCacheBuild({ force_embed: true }, window)).resolves.not.toBe(
      await fingerprintCatalogCacheBuild({ force_stack: true }, window),
    );
  });
});

describe('loadResumeState', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    checkpoint: {
      checkpoint_version: CHECKPOINT_VERSION,
      job_type: 'batch_describe',
      fingerprint: 'fp',
      processed_pairs: ['a|catalog', 'b|catalog'],
      total_at_start: 2,
      ...over,
    },
  });

  it('returns the processed set when the fingerprint agrees', () => {
    expect(loadPairs(body(), 'fp')).toEqual(new Set(['a|catalog', 'b|catalog']));
  });

  it('discards the checkpoint and says so when the inputs changed', () => {
    const logs: string[] = [];
    expect(loadPairs(body(), 'different', (m) => logs.push(m)).size).toBe(0);
    expect(logs).toEqual([MISMATCH]);
  });

  /** Nothing to tell the user about a first run or an old-format checkpoint. */
  it('is silent when there is no usable checkpoint', () => {
    const logs: string[] = [];
    const push = (m: string) => logs.push(m);
    expect(loadPairs({}, 'fp', push).size).toBe(0);
    expect(loadPairs(body({ checkpoint_version: 99 }), 'fp', push).size).toBe(0);
    expect(loadPairs(body({ job_type: 'batch_score' }), 'fp', push).size).toBe(0);
    expect(logs).toEqual([]);
  });
});

describe('the nested batch_analyze checkpoint', () => {
  const nested = (over: Record<string, unknown> = {}) => ({
    checkpoint: {
      checkpoint_version: CHECKPOINT_VERSION,
      job_type: 'batch_analyze',
      stage: 'score',
      describe: { fingerprint: 'dfp', processed_pairs: ['a|catalog'], total_at_start: 1 },
      score: { fingerprint: 'sfp', processed_triplets: ['a|catalog|street'], total_at_start: 1 },
      ...over,
    },
  });

  it('reads both stages out of one checkpoint', () => {
    expect(readAnalyzeCheckpoint(nested())).toEqual({
      stage: 'score',
      cull: {},
      describe: { fingerprint: 'dfp', processed_pairs: ['a|catalog'], total_at_start: 1 },
      score: { fingerprint: 'sfp', processed_triplets: ['a|catalog|street'], total_at_start: 1 },
    });
  });

  /** A flat checkpoint from either standalone job is not a composite one. */
  it('reads nothing out of a checkpoint belonging to another job type', () => {
    const flat = {
      checkpoint: {
        checkpoint_version: CHECKPOINT_VERSION,
        job_type: 'batch_describe',
        fingerprint: 'dfp',
        processed_pairs: ['a|catalog'],
      },
    };
    expect(readAnalyzeCheckpoint(flat)).toEqual({ stage: null, cull: {}, describe: {}, score: {} });
    expect(readAnalyzeCheckpoint({})).toEqual({ stage: null, cull: {}, describe: {}, score: {} });
  });

  it('resumes a stage from its own sub-object', () => {
    expect(
      loadResumeState({
        metadata: nested(),
        jobType: 'batch_score',
        resumeKey: 'processed_triplets',
        fingerprint: 'sfp',
        mismatchMessage: null,
        log: () => {},
        analyzeStage: 'score',
      }),
    ).toEqual(new Set(['a|catalog|street']));
  });

  /** Each stage's fingerprint is checked alone; describe's moving is score's business. */
  it('discards one stage without disturbing the other', () => {
    const logs: string[] = [];
    const resumed = loadResumeState({
      metadata: nested(),
      jobType: 'batch_describe',
      resumeKey: 'processed_pairs',
      fingerprint: 'moved',
      mismatchMessage: 'describe moved',
      log: (m) => logs.push(m),
      analyzeStage: 'describe',
    });

    expect(resumed.size).toBe(0);
    expect(logs).toEqual(['describe moved']);
  });

  it('writes one stage without dropping what the other stored', () => {
    let metadata: Record<string, unknown> = nested();
    const runner = {
      readMetadata: () => metadata,
      persistCheckpoint: (_id: string, checkpointBody: Record<string, unknown>) => {
        metadata = { checkpoint: { checkpoint_version: CHECKPOINT_VERSION, ...checkpointBody } };
      },
    };

    persistAnalyzeStageCheckpoint(
      runner,
      'job-1',
      'score',
      buildAnalyzeStagePayload({
        fingerprint: 'sfp',
        processed: new Set(['b|catalog|street', 'a|catalog|street']),
        totalAtStart: 2,
        resumeKey: 'processed_triplets',
      }),
    );

    expect(readAnalyzeCheckpoint(metadata)).toEqual({
      stage: 'score',
      cull: {},
      describe: { fingerprint: 'dfp', processed_pairs: ['a|catalog'], total_at_start: 1 },
      score: {
        fingerprint: 'sfp',
        processed_triplets: ['a|catalog|street', 'b|catalog|street'],
        total_at_start: 2,
      },
    });
  });
});

describe('describe/score cull sub-checkpoint', () => {
  it('keeps the cull sub-object across describe progress writes', () => {
    let metadata: Record<string, unknown> = {};
    const runner = {
      readMetadata: () => metadata,
      persistCheckpoint: (_id: string, body: Record<string, unknown>) => {
        metadata = { checkpoint: { checkpoint_version: CHECKPOINT_VERSION, ...body } };
      },
    };
    mergeDescribeScoreCullCheckpoint(runner, 'j1', 'batch_describe', {
      fingerprint: 'cfp',
      failed_keys: ['x'],
      total_at_start: 1,
    });
    runner.persistCheckpoint('j1', {
      job_type: 'batch_describe',
      fingerprint: 'dfp',
      processed_pairs: ['a|catalog'],
      total_at_start: 1,
      cull: readDescribeScoreCullSubObject(metadata, 'batch_describe'),
    });
    expect(readDescribeScoreCullSubObject(metadata, 'batch_describe')).toMatchObject({
      fingerprint: 'cfp',
      failed_keys: ['x'],
    });
  });

  it('analyze nested checkpoint records the cull stage', () => {
    let metadata: Record<string, unknown> = {};
    const runner = {
      readMetadata: () => metadata,
      persistCheckpoint: (_id: string, body: Record<string, unknown>) => {
        metadata = { checkpoint: { checkpoint_version: CHECKPOINT_VERSION, ...body } };
      },
    };
    persistAnalyzeStageCheckpoint(runner, 'j1', 'cull', {
      fingerprint: 'cfp',
      failed_keys: ['a'],
      total_at_start: 2,
      done_by_stage: {},
    });
    expect(readAnalyzeCheckpoint(metadata)).toMatchObject({
      stage: 'cull',
      cull: { fingerprint: 'cfp', failed_keys: ['a'], total_at_start: 2 },
    });
  });
});

describe('buildBatchDescribeCheckpointBody', () => {
  it('sorts the processed pairs so the stored body is stable', () => {
    expect(
      buildBatchDescribeCheckpointBody({
        fingerprint: 'fp',
        processed: new Set(['b|catalog', 'a|catalog']),
        totalAtStart: 5,
      }),
    ).toEqual({
      job_type: 'batch_describe',
      fingerprint: 'fp',
      processed_pairs: ['a|catalog', 'b|catalog'],
      total_at_start: 5,
    });
  });
});

describe('buildBatchScoreCheckpointBody', () => {
  it('sorts the processed triplets so the stored body is stable', () => {
    expect(
      buildBatchScoreCheckpointBody({
        fingerprint: 'fp',
        processed: new Set(['b|catalog|street', 'a|catalog|light']),
        totalAtStart: 4,
      }),
    ).toEqual({
      job_type: 'batch_score',
      fingerprint: 'fp',
      processed_triplets: ['a|catalog|light', 'b|catalog|street'],
      total_at_start: 4,
    });
  });
});

describe('buildBatchEmbedImageCheckpointBody', () => {
  /** Embed checkpoints store bare keys under the legacy processed_pairs field name. */
  it('stores bare catalog keys under the processed_pairs name', () => {
    expect(
      buildBatchEmbedImageCheckpointBody({
        fingerprint: 'fp',
        processed: new Set(['b', 'a']),
        totalAtStart: 2,
      }),
    ).toEqual({
      job_type: 'batch_embed_image',
      fingerprint: 'fp',
      processed_pairs: ['a', 'b'],
      total_at_start: 2,
    });
  });
});

describe('buildBatchStackDetectCheckpointBody', () => {
  /** Stack checkpoints use processed_image_keys for the same list. */
  it('stores catalog keys under processed_image_keys', () => {
    expect(
      buildBatchStackDetectCheckpointBody({
        fingerprint: 'fp',
        processed: new Set(['b', 'a']),
        totalAtStart: 2,
      }),
    ).toEqual({
      job_type: 'batch_stack_detect',
      fingerprint: 'fp',
      processed_image_keys: ['a', 'b'],
      total_at_start: 2,
    });
  });
});

describe('buildBatchCullCheckpointBody', () => {
  it('caps failed_keys and says so', () => {
    const failed = new Set(Array.from({ length: CHECKPOINT_MAX_ENTRIES + 2 }, (_, i) => `k${String(i).padStart(7, '0')}`));
    const lines: string[] = [];
    const body = buildBatchCullCheckpointBody({
      fingerprint: 'f',
      state: { doneByStage: { s: 3 }, failed, totalAtStart: null },
      totalAtStart: 9,
      log: (m) => lines.push(m),
    });
    expect((body.failed_keys as string[]).length).toBe(CHECKPOINT_MAX_ENTRIES);
    expect(body).toMatchObject({ done_by_stage: { s: 3 }, total_at_start: 9 });
    expect(lines).toEqual([`checkpoint: ${failed.size} failed photos, keeping the first ${CHECKPOINT_MAX_ENTRIES}`]);
  });
});

