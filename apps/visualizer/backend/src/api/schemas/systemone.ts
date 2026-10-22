/**
 * The System One wire protocol this app serves (ADR-0021): TypeSafe's `POST /v1/systemone` and
 * `GET /v1/models`, with images as Ollama and oMLX take them (`images: [base64]`).
 *
 * Two additions, `x_`-prefixed as Laya serve's are: a model's identity in the list (`x_model_id`), and a
 * noul's false/true probabilities, so a stored answer reads back exactly.
 */
import { z } from '@hono/zod-openapi';

const ScoreQuestion = z.object({
  type: z.literal('score'),
  instructions: z.string(),
  criteria: z.array(z.string()).min(1).describe('Levels, lowest first'),
});
const ChoiceQuestion = z.object({
  type: z.literal('choice'),
  instructions: z.string(),
  criteria: z.union([z.array(z.string()).min(1), z.record(z.string(), z.string().nullable())]),
});
const NoulQuestion = z.object({
  type: z.literal('noul'),
  instructions: z.string(),
  criteria: z.object({ true: z.string().nullish(), false: z.string().nullish() }).nullish(),
});

export const SystemOneQuestion = z
  .discriminatedUnion('type', [ScoreQuestion, ChoiceQuestion, NoulQuestion])
  .openapi('SystemOneQuestion');

export const SystemOneRequest = z
  .object({
    model: z.string().min(1).describe('A name from GET /v1/models'),
    state: z
      .literal('')
      .optional()
      .describe('Empty: this endpoint answers about the image alone, as its models were trained'),
    images: z.array(z.string().min(1)).length(1).describe('One image, base64 or a data: URL'),
    questions: z
      .record(z.string(), SystemOneQuestion)
      .refine((q) => Object.keys(q).length > 0, 'at least one question'),
  })
  .openapi('SystemOneRequest');

const Probabilities = z.record(z.string(), z.number());

export const SystemOneAnswer = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('score'),
      score: z.number().describe('Expected level, from 0'),
      confidence: z.number(),
      legend: z.record(z.string(), z.string()),
      probabilities: Probabilities.describe('By level, "0" first'),
    }),
    z.object({
      type: z.literal('choice'),
      choice: z.string(),
      confidence: z.number(),
      probabilities: Probabilities,
    }),
    z.object({
      type: z.literal('noul'),
      noul: z.number().describe('P(true)'),
      probabilities: z.object({ false: z.number(), true: z.number() }),
    }),
  ])
  .openapi('SystemOneAnswer');

export const SystemOneResponse = z
  .object({
    model: z.string(),
    answers: z.record(z.string(), SystemOneAnswer),
    usage: z.object({ input_tokens: z.number().int(), output_tokens: z.number().int() }),
  })
  .openapi('SystemOneResponse');

export const SystemOneModels = z
  .object({
    models: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        release_date: z.string(),
        x_model_id: z.string().describe('What answers under this name: a revision or a file hash'),
      }),
    ),
  })
  .openapi('SystemOneModels');
