/**
 * Score forecast questions: what the Score forecast's model answers, edited by the user like a culling
 * profile's text (#368). Pure: no database.
 *
 * Each question is asked as a 10-level `score` question under its own id. An optional question is also
 * asked "applies?" as a `noul` under `<id>-excusal`; when the photo is excused the question is left out
 * (`decide.ts`). This library's questions are the rows Laya new was trained on, so turning them into
 * what the model is asked must give `questions.json` "new" back exactly: its stage version hashes it.
 */
import type { LayaQuestion } from '../laya/rows.js';

export const LEVELS_PER_QUESTION = 10;
export const EXCUSAL_SUFFIX = '-excusal';

export interface ScoreForecastQuestion {
  /** Fixed when the question is made: the stored answers are keyed by it. */
  id: string;
  name: string;
  perspective_slug: string | null;
  instructions: string;
  /** Lowest first. */
  levels: string[];
  optional: boolean;
  /** The "applies?" question; null unless optional. */
  applies: string | null;
}

export const excusalId = (id: string): string => `${id}${EXCUSAL_SUFFIX}`;

/** Exactly what the model is asked, by question id. */
export function forecastStageQuestions(questions: readonly ScoreForecastQuestion[]): Record<string, LayaQuestion> {
  const out: Record<string, LayaQuestion> = {};
  for (const q of questions) {
    if (q.optional) out[excusalId(q.id)] = { type: 'noul', instructions: q.applies ?? '' };
    out[q.id] = { type: 'score', instructions: q.instructions, criteria: q.levels };
  }
  return out;
}

/**
 * Questions that ask exactly `asked`: each `score` row a question, tied to the perspective of the same
 * slug when there is one, optional when an `<id>-excusal` row comes with it.
 */
export function questionsFromLaya(
  asked: Readonly<Record<string, LayaQuestion>>,
  perspectiveNames: Readonly<Record<string, string>>,
): ScoreForecastQuestion[] {
  return Object.entries(asked)
    .filter(([, q]) => q.type === 'score')
    .map(([id, q]) => {
      const applies = asked[excusalId(id)];
      return {
        id,
        name: perspectiveNames[id] ?? id,
        perspective_slug: id in perspectiveNames ? id : null,
        instructions: q.instructions,
        levels: [...(q.criteria as string[])],
        optional: applies !== undefined,
        applies: applies?.instructions ?? null,
      };
    });
}

const RANGE_FIRST = /^\s*[-*]\s+\*\*([^*]+?)\*\*\s*\((\d+)\s*[-–]\s*(\d+)\)\s*:\s*(.+?)\s*$/;
const RANGE_IN_LABEL = /^\s*[-*]\s+\*\*(\d+)\s*[-–]\s*(\d+)\s+([^*]+?)\*\*\s*[—–-]\s*(.+?)\s*$/;

/**
 * A perspective's scoring bands as 10 levels, `N of 10 — <band>: <text>` (the form Laya new was trained
 * on). Reads `**weak** (1-3): …` and `**9–10 Iconic** — …`; a single-score band such as
 * `not_applicable` is not a range and is left out. Null unless the bands cover 1 to 10 once each.
 */
export function scoringLevels(markdown: string): string[] | null {
  const levels: (string | undefined)[] = new Array(LEVELS_PER_QUESTION).fill(undefined);
  for (const line of markdown.split('\n')) {
    const a = RANGE_FIRST.exec(line);
    const b = a ? null : RANGE_IN_LABEL.exec(line);
    const band = a ? { label: a[1]!, from: +a[2]!, to: +a[3]!, text: a[4]! } : b ? { label: b[3]!, from: +b[1]!, to: +b[2]!, text: b[4]! } : null;
    if (!band || band.from < 1 || band.to > LEVELS_PER_QUESTION || band.from > band.to) continue;
    for (let n = band.from; n <= band.to; n += 1) {
      if (levels[n - 1] !== undefined) return null;
      levels[n - 1] = `${n} of ${LEVELS_PER_QUESTION} — ${band.label.trim()}: ${band.text}`;
    }
  }
  return levels.every((l) => l !== undefined) ? (levels as string[]) : null;
}

export interface PerspectiveForQuestions {
  slug: string;
  display_name: string;
  description: string;
  prompt_markdown: string;
  optional: number | null;
}

const withoutComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, '').trim();

/**
 * The perspective's description, or — when it has none, as a factory-seeded optional perspective whose
 * description is its `<!-- optional: true -->` marker — the rubric's first paragraph.
 */
function perspectiveText(p: PerspectiveForQuestions): string {
  const description = withoutComments(p.description);
  if (description) return description;
  const paragraphs = withoutComments(p.prompt_markdown).split(/\n\s*\n/).map((s) => s.trim());
  return paragraphs.find((s) => s && !s.startsWith('#') && !/^[-*]\s/.test(s))?.replace(/\s+/g, ' ') ?? '';
}

/**
 * "Create questions from my perspectives": a script, no model. One question per perspective, its text
 * the perspective's description and its levels the scoring bands, plus "applies?" for an optional one.
 * A perspective whose bands cannot be read is skipped and named.
 */
export function questionsFromPerspectives(perspectives: readonly PerspectiveForQuestions[]): {
  questions: ScoreForecastQuestion[];
  skipped: string[];
} {
  const questions: ScoreForecastQuestion[] = [];
  const skipped: string[] = [];
  for (const p of perspectives) {
    const levels = scoringLevels(p.prompt_markdown);
    if (!levels) {
      skipped.push(p.display_name);
      continue;
    }
    const description = perspectiveText(p);
    const optional = p.optional === 1;
    questions.push({
      id: p.slug,
      name: p.display_name,
      perspective_slug: p.slug,
      instructions: description,
      levels,
      optional,
      applies: optional ? `Does "${p.display_name}" apply to this photo? ${description}` : null,
    });
  }
  return { questions, skipped };
}

const ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** Problems by field (`<id>.<field>`, or the id for the question as a whole); empty when it can be saved. */
export function validateForecastQuestions(
  questions: readonly ScoreForecastQuestion[],
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q.name.trim()) errors.push({ field: `${q.id}.name`, message: 'A question needs a name' });
    if (!q.instructions.trim()) errors.push({ field: `${q.id}.instructions`, message: 'A question needs its text' });
    if (seen.has(q.id)) errors.push({ field: q.id, message: `Two questions have the id ${q.id}` });
    seen.add(q.id);
    if (q.levels.length !== LEVELS_PER_QUESTION || q.levels.some((l) => !l.trim())) {
      errors.push({ field: `${q.id}.levels`, message: `A question has exactly ${LEVELS_PER_QUESTION} levels, each with its text` });
    }
    if (q.id.endsWith(EXCUSAL_SUFFIX)) errors.push({ field: q.id, message: `A question id cannot end in ${EXCUSAL_SUFFIX}` });
    if (q.optional && !q.applies?.trim()) {
      errors.push({ field: `${q.id}.applies`, message: 'An optional question needs its "applies?" text' });
    }
    if (!ID.test(q.id)) errors.push({ field: q.id, message: 'A question id is lowercase letters, digits, dashes and underscores' });
  }
  return errors;
}
