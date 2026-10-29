/**
 * Provider model rows in `visualizer.db`.
 */
import type { Db } from '../connection.js';

export type ProviderModelOrigin = 'config' | 'user';

export interface ProviderModelRow {
  provider_id: string;
  model_id: string;
  model_name: string;
  origin: ProviderModelOrigin;
  image_refused_at: string | null;
  image_refused_reason: string | null;
}

/** Add mark columns and fold legacy `vision = 0` into refusals. */
export function migrateLegacyVisionColumn(db: Db): void {
  const columns = db.pragma('table_info(provider_models)') as { name: string }[];
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('image_refused_at')) {
    db.exec('ALTER TABLE provider_models ADD COLUMN image_refused_at TEXT');
  }
  if (!names.has('image_refused_reason')) {
    db.exec('ALTER TABLE provider_models ADD COLUMN image_refused_reason TEXT');
  }
  if (!names.has('origin')) {
    db.exec("ALTER TABLE provider_models ADD COLUMN origin TEXT NOT NULL DEFAULT 'config'");
  }
  if (names.has('vision')) {
    db.exec(`
      UPDATE provider_models
      SET image_refused_at = COALESCE(image_refused_at, datetime('now')),
          image_refused_reason = COALESCE(image_refused_reason, 'declared without image input')
      WHERE vision = 0 AND image_refused_at IS NULL
    `);
  }
}

export function modelAcceptsImages(row: Pick<ProviderModelRow, 'image_refused_at'>): boolean {
  return row.image_refused_at === null;
}

export function visionFromRow(row: Pick<ProviderModelRow, 'image_refused_at'>): boolean {
  return modelAcceptsImages(row);
}

export function listProviderModels(db: Db, providerId?: string): ProviderModelRow[] {
  const sql = `
    SELECT provider_id, model_id, model_name, origin, image_refused_at, image_refused_reason
    FROM provider_models
    ${providerId !== undefined ? 'WHERE provider_id = ?' : ''}
    ORDER BY provider_id, model_id
  `;
  if (providerId !== undefined) {
    return db.prepare(sql).all(providerId) as ProviderModelRow[];
  }
  return db.prepare(sql).all() as ProviderModelRow[];
}

export function insertProviderModel(
  db: Db,
  opts: {
    providerId: string;
    modelId: string;
    modelName: string;
    origin: ProviderModelOrigin;
    acceptsImages: boolean;
    refusedReason: string | null;
  },
): void {
  const refusedAt = opts.acceptsImages ? null : new Date().toISOString();
  const refusedReason = opts.acceptsImages ? null : opts.refusedReason;
  db.prepare(
    `
    INSERT INTO provider_models (
      provider_id, model_id, model_name, origin, image_refused_at, image_refused_reason, vision
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, model_id) DO UPDATE SET
      model_name = excluded.model_name,
      origin = excluded.origin,
      image_refused_at = excluded.image_refused_at,
      image_refused_reason = excluded.image_refused_reason,
      vision = excluded.vision
    `,
  ).run(
    opts.providerId,
    opts.modelId,
    opts.modelName,
    opts.origin,
    refusedAt,
    refusedReason,
    opts.acceptsImages ? 1 : 0,
  );
}

/** Raised when the (provider, model) pair already exists; the API maps it to 409. */
export class DuplicateUserModelError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`Model ${modelId} already exists for ${providerId}`);
    this.name = 'DuplicateUserModelError';
  }
}

/** Insert a user-defined model row. */
export function addUserModel(
  db: Db,
  providerId: string,
  modelId: string,
  modelName: string,
  vision = true,
): void {
  const refusedAt = vision ? null : new Date().toISOString();
  const refusedReason = vision ? null : 'declared without image input';
  try {
    db.prepare(
      `
      INSERT INTO provider_models (
        provider_id, model_id, model_name, origin, image_refused_at, image_refused_reason, vision
      )
      VALUES (?, ?, ?, 'user', ?, ?, ?)
      `,
    ).run(providerId, modelId, modelName, refusedAt, refusedReason, vision ? 1 : 0);
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new DuplicateUserModelError(providerId, modelId);
    }
    throw e;
  }
}

/** Record that the provider refused an image for this model. */
export function markModelImageRefused(
  db: Db,
  providerId: string,
  modelId: string,
  reason: string,
): void {
  const trimmed = reason.trim().slice(0, 500);
  const existing = db
    .prepare('SELECT model_name, origin FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .get(providerId, modelId) as { model_name: string; origin: ProviderModelOrigin } | undefined;
  if (existing) {
    db.prepare(
      `
      UPDATE provider_models
      SET image_refused_at = datetime('now'),
          image_refused_reason = ?,
          vision = 0
      WHERE provider_id = ? AND model_id = ?
      `,
    ).run(trimmed, providerId, modelId);
    return;
  }
  insertProviderModel(db, {
    providerId,
    modelId,
    modelName: modelId,
    origin: 'config',
    acceptsImages: false,
    refusedReason: trimmed,
  });
}

/** Clear an image-refusal mark so jobs may try the model again. */
export function clearModelImageRefusal(db: Db, providerId: string, modelId: string): boolean {
  const info = db
    .prepare(
      `
      UPDATE provider_models
      SET image_refused_at = NULL, image_refused_reason = NULL, vision = 1
      WHERE provider_id = ? AND model_id = ? AND image_refused_at IS NOT NULL
      `,
    )
    .run(providerId, modelId);
  return info.changes > 0;
}

/** Rename a model and clear any image-refusal mark. */
export function updateProviderModelName(
  db: Db,
  providerId: string,
  modelId: string,
  modelName: string,
): boolean {
  const info = db
    .prepare(
      `
      UPDATE provider_models
      SET model_name = ?, image_refused_at = NULL, image_refused_reason = NULL, vision = 1
      WHERE provider_id = ? AND model_id = ?
      `,
    )
    .run(modelName, providerId, modelId);
  return info.changes > 0;
}

/** Clear image-refusal marks for every model on a provider (address change). */
export function clearProviderImageRefusalMarks(db: Db, providerId: string): void {
  db.prepare(
    `
    UPDATE provider_models
    SET image_refused_at = NULL,
        image_refused_reason = NULL,
        vision = 1
    WHERE provider_id = ? AND image_refused_at IS NOT NULL
    `,
  ).run(providerId);
}

/** Delete a model row. Returns whether one was removed. */
export function deleteUserModel(db: Db, providerId: string, modelId: string): boolean {
  const info = db
    .prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?')
    .run(providerId, modelId);
  return info.changes > 0;
}

/** @deprecated use listProviderModels */
export function getUserModels(db: Db, providerId?: string): ProviderModelRow[] {
  return listProviderModels(db, providerId);
}
