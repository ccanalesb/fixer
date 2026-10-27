/**
 * Builds a real `library.db` for route tests.
 *
 * Uses a real SQLite file and `createLibrarySchema` (same DDL as production) so
 * queries actually execute against the real schema.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { serializeFloat32 } from '../../src/db/connection.js';
import { createLibrarySchema, initLibraryDb } from '../../src/db/library/bootstrap.js';
import { saveForecastQuestions } from '../../src/db/library/score-forecast-questions.js';
import { forecastQuestionsFrom } from '../../src/cull/forecast-questions.js';
import { FACTORY_QUESTIONS } from '../../src/app-models/factory-questions.js';
import { nowIsoLocal, nowIsoUtc } from '../../src/utils/datetime.js';
import { seedCullingStagesOn } from './culling-stages.js';

export interface PerspectiveSeed {
  slug: string;
  display_name?: string;
  description?: string;
  prompt_markdown?: string;
  active?: boolean;
  optional?: boolean;
  source_filename?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ScoreSeed {
  image_key: string;
  perspective_slug: string;
  score: number;
  image_type?: string;
  /** `NOT NULL DEFAULT ''` in the real schema, so these default to '' and not null. */
  rationale?: string;
  model_used?: string;
  prompt_version?: string;
  scored_at?: string;
  is_current?: boolean;
  repaired_from_malformed?: boolean;
  not_attempted?: boolean;
}

export interface ImageSeed {
  key: string;
  id?: string | null;
  filename?: string;
  filepath?: string;
  date_taken?: string | null;
  rating?: number;
  pick?: number;
  color_label?: string;
  /** Stored as JSON text, the way the catalog sync writes it. */
  keywords?: string;
  title?: string;
  description?: string;
  instagram_posted?: boolean;
  width?: number;
  height?: number;
}

export class LibraryFixture {
  readonly dir: string;
  readonly dbPath: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'lt-lib-'));
    this.dbPath = join(this.dir, 'library.db');
    const db = this.open();
    createLibrarySchema(db);
    db.close();
  }

  private open(): Database.Database {
    const db = new Database(this.dbPath);
    // `image_clip_embeddings` is a `vec0` virtual table, so even reading it needs
    // the extension the production connection loads.
    sqliteVec.load(db);
    return db;
  }

  addPerspectives(...seeds: PerspectiveSeed[]): this {
    const db = this.open();
    const stmt = db.prepare(
      `INSERT INTO perspectives
         (slug, display_name, description, prompt_markdown, active, optional,
          source_filename, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of seeds) {
      stmt.run(
        s.slug,
        s.display_name ?? s.slug,
        s.description ?? '',
        s.prompt_markdown ?? `# ${s.slug}`,
        s.active === false ? 0 : 1,
        s.optional ? 1 : 0,
        s.source_filename ?? null,
        s.created_at ?? '2026-01-01T00:00:00+00:00',
        s.updated_at ?? '2026-01-02T00:00:00+00:00',
      );
    }
    db.close();
    return this;
  }

  addScores(...seeds: ScoreSeed[]): this {
    const db = this.open();
    const stmt = db.prepare(
      `INSERT INTO image_scores
         (image_key, image_type, perspective_slug, score, rationale, model_used,
          prompt_version, scored_at, is_current, repaired_from_malformed, not_attempted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of seeds) {
      stmt.run(
        s.image_key,
        s.image_type ?? 'catalog',
        s.perspective_slug,
        s.score,
        s.rationale ?? '',
        s.model_used ?? '',
        s.prompt_version ?? 'v1',
        s.scored_at ?? '2026-01-01T00:00:00+00:00',
        s.is_current === false ? 0 : 1,
        s.repaired_from_malformed ? 1 : 0,
        s.not_attempted ? 1 : 0,
      );
    }
    db.close();
    return this;
  }

  addImages(...keys: string[]): this {
    const db = this.open();
    const stmt = db.prepare('INSERT INTO images (key, filename, filepath) VALUES (?, ?, ?)');
    for (const k of keys) stmt.run(k, `${k}.jpg`, `/photos/${k}.jpg`);
    db.close();
    return this;
  }

  /** An image with explicit column values, for tests that filter or sort on them. */
  addImage(seed: ImageSeed): this {
    const db = this.open();
    db.prepare(
      `INSERT INTO images
         (key, id, filename, filepath, date_taken, rating, pick, color_label,
          keywords, title, description, instagram_posted, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.key,
      seed.id ?? null,
      seed.filename ?? `${seed.key}.jpg`,
      seed.filepath ?? `/photos/${seed.key}.jpg`,
      seed.date_taken ?? null,
      seed.rating ?? 0,
      seed.pick ?? 0,
      seed.color_label ?? '',
      seed.keywords ?? '[]',
      seed.title ?? '',
      seed.description ?? '',
      seed.instagram_posted ? 1 : 0,
      seed.width ?? null,
      seed.height ?? null,
    );
    db.close();
    return this;
  }

  /**
   * Create a stack over `memberKeys`, with the first as representative unless
   * `representative` says otherwise. Returns the fixture; read the id with
   * `stackIdFor`.
   */
  addStack(memberKeys: string[], representative?: string): number {
    const db = this.open();
    const rep = representative ?? memberKeys[0]!;
    const info = db
      .prepare('INSERT INTO image_stacks (representative_key, stack_size) VALUES (?, ?)')
      .run(rep, memberKeys.length);
    const stackId = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      'INSERT INTO image_stack_members (stack_id, image_key) VALUES (?, ?)',
    );
    for (const k of memberKeys) stmt.run(stackId, k);
    db.close();
    return stackId;
  }

  /** A similarity group with ranked candidates. Returns the group id. */
  addSimilarityGroup(seed: {
    seed_key: string;
    candidates: { key: string; similarity: number; why_matched?: string }[];
    job_id?: string | null;
    created_at?: string;
  }): number {
    const db = this.open();
    const best = Math.max(...seed.candidates.map((c) => c.similarity));
    const info = db
      .prepare(
        `INSERT INTO catalog_similarity_groups
           (seed_key, candidate_count, best_similarity, job_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        seed.seed_key,
        seed.candidates.length,
        best,
        seed.job_id ?? null,
        seed.created_at ?? '2026-02-01T00:00:00',
      );
    const groupId = Number(info.lastInsertRowid);
    const stmt = db.prepare(
      `INSERT INTO catalog_similarity_candidates
         (group_id, candidate_key, similarity, rank, why_matched)
       VALUES (?, ?, ?, ?, ?)`,
    );
    seed.candidates.forEach((cand, i) => {
      stmt.run(groupId, cand.key, cand.similarity, i + 1, cand.why_matched ?? '');
    });
    db.close();
    return groupId;
  }

  /**
   * A stored CLIP vector: a constant fill for tests that only care whether a row
   * exists, or an explicit vector for tests that rank against it.
   */
  addClipEmbedding(imageKey: string, vector: number | Float32Array = 0): this {
    const db = this.open();
    db.prepare('INSERT INTO image_clip_embeddings(embedding, image_key) VALUES (?, ?)').run(
      serializeFloat32(
        typeof vector === 'number' ? new Float32Array(512).fill(vector) : vector,
      ),
      imageKey,
    );
    db.close();
    return this;
  }

  /** Point an image at a cached JPEG, the way `prepare_catalog` leaves the row. */
  addVisionCache(imageKey: string, compressedPath: string): this {
    const db = this.open();
    db.prepare(
      `INSERT INTO vision_cache (key, compressed_path, phash, compressed_at, original_mtime)
       VALUES (?, ?, NULL, ?, 12345.0)`,
    ).run(imageKey, compressedPath, nowIsoLocal());
    db.close();
    return this;
  }

  /** A user "not a duplicate" verdict; the table's CHECK needs the pair sorted. */
  addSimilarityRejection(keyA: string, keyB: string): this {
    const [a, b] = [keyA, keyB].sort();
    const db = this.open();
    db.prepare('INSERT INTO catalog_similarity_rejections (key_a, key_b) VALUES (?, ?)').run(a, b);
    db.close();
    return this;
  }

  /** Condemn a frame, which removes it from suggestions and the flagged filter. */
  addFrameSubstance(imageKey: string, verdict: 'void' | 'illegible' | 'ok' | 'unknown'): this {
    const db = this.open();
    db.prepare(
      `INSERT INTO image_frame_substance (image_key, verdict, detector_version, judged_at, run_id)
       VALUES (?, ?, 'test', ?, 1)`,
    ).run(imageKey, verdict, nowIsoUtc());
    db.close();
    return this;
  }

  /** A user override, which un-condemns a flagged frame. */
  addFrameSubstanceOverride(imageKey: string): this {
    const db = this.open();
    db.prepare('INSERT INTO frame_substance_overrides (image_key) VALUES (?)').run(imageKey);
    db.close();
    return this;
  }

  /** Direct SQL, for the handful of assertions that need to inspect writes. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const db = this.open();
    try {
      return db.prepare(sql).all(...(params as never[])) as T[];
    } finally {
      db.close();
    }
  }

  /** Direct SQL that writes, for tests that mutate a seed mid-run. */
  exec(sql: string, ...params: unknown[]): void {
    const db = this.open();
    try {
      db.prepare(sql).run(...(params as never[]));
    } finally {
      db.close();
    }
  }

  /** The factory Score forecast questions, as this library has them. */
  addForecastQuestions(): this {
    const db = this.open();
    try {
      saveForecastQuestions(db, forecastQuestionsFrom(FACTORY_QUESTIONS.score_forecast, {}));
    } finally {
      db.close();
    }
    return this;
  }

  /** The culling defaults, with the culling profile and the Score forecast on. */
  cullingStagesOn(): this {
    const db = this.open();
    try {
      seedCullingStagesOn(db);
    } finally {
      db.close();
    }
    return this;
  }

  /** Point the app at this database for the duration of a test. */
  activate(): this {
    process.env.LIBRARY_DB = this.dbPath;
    return this;
  }

  /**
   * Factory perspectives and culling defaults, the same work as `initLibraryDb` after the bare schema.
   * Closes the connection so temp cleanup can remove the directory on Windows.
   */
  seedFactoryDefaults(): this {
    initLibraryDb(this.dbPath).close();
    return this;
  }

  cleanup(): void {
    delete process.env.LIBRARY_DB;
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
