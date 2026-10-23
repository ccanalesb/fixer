import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import {
  forecastStageQuestions,
  forecastQuestionsFrom,
  questionsFromPerspectives,
  scoringLevels,
  validateForecastQuestions,
  type ScoreForecastQuestion,
} from '../src/cull/forecast-questions.js';
import { FACTORY_QUESTIONS } from '../src/app-models/factory-questions.js';
import { canonicalJson } from '../src/utils/canonical-json.js';

const seed = (slug: string) => readFileSync(join(REPO_ROOT, 'prompts', 'perspectives', `${slug}.md`), 'utf8');

const perspective = (slug: string, name: string, optional: boolean, markdown = seed(slug)) => ({
  slug,
  display_name: name,
  description: `${name} description.`,
  prompt_markdown: markdown,
  optional: optional ? 1 : 0,
});

const question = (over: Partial<ScoreForecastQuestion> = {}): ScoreForecastQuestion => ({
  id: 'framing',
  name: 'Framing',
  perspective_slug: 'framing',
  instructions: 'How well does a framing device enclose the subject?',
  levels: Array.from({ length: 10 }, (_, i) => `level ${i + 1}`),
  optional: false,
  applies: null,
  ...over,
});

describe('Score forecast questions → what the model is asked', () => {
  it("this library's questions come back exactly as questions.json \"new\", so the stage version does not change", () => {
    const names = { framing: 'Framing', 'compositional-cleanliness': 'Compositional Cleanliness' };
    const questions = forecastQuestionsFrom(FACTORY_QUESTIONS.score_forecast, names);
    expect(canonicalJson(forecastStageQuestions(questions))).toBe(canonicalJson(FACTORY_QUESTIONS.score_forecast));
    expect(questions.map((q) => [q.id, q.name, q.perspective_slug, q.optional])).toEqual([
      ['framing', 'Framing', 'framing', true],
      ['compositional-cleanliness', 'Compositional Cleanliness', 'compositional-cleanliness', false],
      ['environmental-context-legibility', 'environmental-context-legibility', null, false],
      ['intensity-suggestion', 'intensity-suggestion', null, false],
    ]);
  });

  it('an optional question is asked with its "applies?" question, a noul', () => {
    const asked = forecastStageQuestions([question({ optional: true, applies: 'Is there a framing device?' })]);
    expect(asked['framing-excusal']).toEqual({ type: 'noul', instructions: 'Is there a framing device?' });
    expect(asked.framing).toEqual({ type: 'score', instructions: question().instructions, criteria: question().levels });
  });
});

describe('Create questions from my perspectives', () => {
  it('four active perspectives, one optional: four questions and one "applies?" question', () => {
    const { questions, skipped } = questionsFromPerspectives([
      perspective('framing', 'Framing', true),
      perspective('compositional-cleanliness', 'Compositional Cleanliness', false),
      perspective('environmental-context-legibility', 'Depth & Environmental Context', false),
      perspective('intensity-suggestion', 'Interpretive & Human Charge', false),
    ]);
    expect(skipped).toEqual([]);
    expect(questions).toHaveLength(4);
    const asked = forecastStageQuestions(questions);
    expect(Object.values(asked).filter((q) => q.type === 'noul')).toHaveLength(1);
    expect(Object.keys(asked)).toHaveLength(5);
    const framing = questions.find((q) => q.id === 'framing')!;
    expect(framing).toMatchObject({
      name: 'Framing',
      perspective_slug: 'framing',
      instructions: 'Framing description.',
      optional: true,
      applies: 'Does "Framing" apply to this photo? Framing description.',
    });
    expect(framing.levels).toEqual(FACTORY_QUESTIONS.score_forecast.framing!.criteria);
  });

  it("a factory-seeded optional perspective, whose description is its marker, asks the rubric's first paragraph", () => {
    const { questions } = questionsFromPerspectives([
      { ...perspective('framing', 'Framing', true), description: '<!-- optional: true -->' },
    ]);
    expect(questions[0]!.instructions).toMatch(/^Evaluating the use of a natural framing device—foreground elements/);
    expect(questions[0]!.applies).toBe(`Does "Framing" apply to this photo? ${questions[0]!.instructions}`);
  });

  it('a perspective whose scoring bands cannot be read is skipped and named', () => {
    const { questions, skipped } = questionsFromPerspectives([
      perspective('framing', 'Framing', false),
      perspective('loose', 'Loose', false, '# Loose\n\nJust judge it.'),
    ]);
    expect(questions.map((q) => q.id)).toEqual(['framing']);
    expect(skipped).toEqual(['Loose']);
  });

  it('reads both band formats, leaving out not_applicable', () => {
    expect(scoringLevels(seed('framing'))?.[6]).toMatch(/^7 of 10 — strong: A clear, well-formed framing device/);
    const street = scoringLevels(seed('street'));
    expect(street).toHaveLength(10);
    expect(street![0]).toBe('1 of 10 — Failed: no subject, no tension.');
    expect(street![9]).toBe('10 of 10 — Iconic: layered, timed, unrepeatable.');
    expect(scoringLevels('- **weak** (1-3): a\n- **strong** (7-10): b')).toBeNull();
  });
});

describe('validateForecastQuestions', () => {
  it('accepts a complete question', () => {
    expect(validateForecastQuestions([question()])).toEqual([]);
  });

  it('names each problem by its field', () => {
    const errors = validateForecastQuestions([
      question({ name: ' ', instructions: '' }),
      question({ id: 'framing', levels: ['only one'] }),
      question({ id: 'x-excusal', optional: true, applies: ' ' }),
      question({ id: 'Bad Id' }),
    ]);
    expect(errors).toEqual([
      { field: 'framing.name', message: 'A question needs a name' },
      { field: 'framing.instructions', message: 'A question needs its text' },
      { field: 'framing', message: 'Two questions have the id framing' },
      { field: 'framing.levels', message: 'A question has exactly 10 levels, each with its text' },
      { field: 'x-excusal', message: 'A question id cannot end in -excusal' },
      { field: 'x-excusal.applies', message: 'An optional question needs its "applies?" text' },
      { field: 'Bad Id', message: 'A question id is lowercase letters, digits, dashes and underscores' },
    ]);
  });
});
