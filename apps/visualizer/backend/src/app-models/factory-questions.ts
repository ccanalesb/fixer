/**
 * The questions a new library starts with, per stage: the Default culling profile's at 7 and 10 levels,
 * and the Score forecast's. The converter checks a model's rows against them. Split from `sessions.ts` so
 * the main thread can read them without loading onnxruntime.
 */
import questionsJson from './factory-questions.json' with { type: 'json' };
import type { SystemOneQuestion } from '../systemone/question.js';

export const FACTORY_QUESTIONS = questionsJson as Record<'culling_profile' | 'score_forecast', Record<string, SystemOneQuestion>>;
