/** A question as the System One contract asks it (ADR-0021): every stage's questions, whichever endpoint answers. */
export type QuestionType = 'choice' | 'score' | 'noul';

export interface SystemOneQuestion {
  type: QuestionType;
  instructions: string;
  criteria?: string[] | Record<string, string | null> | null;
}
