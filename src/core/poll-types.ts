/** Poll limits and question types; no imports, so the JSON API's schemas can use them. */

export const QUESTION_TYPES = ['short', 'long', 'dropdown', 'single', 'multiple'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const RESULTS_VISIBILITY = ['everyone', 'managers'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITY)[number];
/** Minutes before the close a reminder may go: 15 minutes, 1 hour or 1 day. */
export const REMINDER_MINUTES = [15, 60, 1440] as const;

export const POLL_LIMITS = { title: 100, intro: 500, questions: 10, question: 200, options: 20, option: 80, short: 200, long: 1000 } as const;

export interface PollQuestion {
  text: string;
  type: QuestionType;
  required: boolean;
  /** Choice questions only; empty for text questions. */
  options: string[];
}
