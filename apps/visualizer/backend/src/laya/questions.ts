/**
 * The Default culling profile's questions at 7 and 10 levels (Laya base) and Laya new's five rows. Split from `sessions.ts` so the main thread can read them without loading
 * onnxruntime.
 */
import questionsJson from './questions.json' with { type: 'json' };
import type { LayaQuestion } from './rows.js';

export type LayaModelName = 'base' | 'new';

export const LAYA_QUESTIONS = questionsJson as Record<LayaModelName, Record<string, LayaQuestion>>;
