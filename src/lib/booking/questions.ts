import {
  QUESTION_TYPES,
  answerText,
  checkAnswers,
  checkQuestionsForSave,
  parseAnswers,
  parseQuestions,
  type Answers,
  type Question,
  type QuestionType,
} from "@/lib/projects/questionnaire";

/**
 * A booking page's own questions (owner, 18 Nov 2026 — Dreamteam's "Who do you sell to?", "Number of employees"): the
 * project questionnaire's rules (src/lib/projects/questionnaire.ts), less file uploads — a stranger's file has no
 * project to land in — and fewer of them, since they stand between a visitor and a booked time. Pure.
 */

export const BOOKING_QUESTION_TYPES: QuestionType[] = QUESTION_TYPES.map((t) => t.type).filter((t) => t !== "FILE");
export const BOOKING_QUESTION_LIMIT = 15;

/** The page's questions as stored, read tolerantly: file questions left out. */
export function bookingQuestions(value: unknown): Question[] {
  return parseQuestions(value).filter((q) => q.type !== "FILE").slice(0, BOOKING_QUESTION_LIMIT);
}

export function checkBookingQuestions(value: unknown): { ok: true; questions: Question[] } | { ok: false; error: string } {
  const raw = Array.isArray(value) ? value : [];
  if (raw.some((q) => (q as { type?: unknown })?.type === "FILE")) return { ok: false, error: "A booking page can't ask for a file." };
  if (raw.length > BOOKING_QUESTION_LIMIT) return { ok: false, error: `A booking page asks ${BOOKING_QUESTION_LIMIT} questions at most.` };
  return checkQuestionsForSave(raw);
}

/** The guest's answers, checked: required ones must be there. The first problem, worded for the page, or the answers. */
export function checkBookingAnswers(questions: Question[], raw: unknown): { ok: true; answers: Answers } | { ok: false; error: string; errors: Record<string, string> } {
  const checked = checkAnswers(questions, raw, {}, true);
  if (checked.ok) return checked;
  const first = questions.find((q) => checked.errors[q.key]);
  return { ok: false, error: first ? `${first.label}: ${checked.errors[first.key]}` : "Check your answers.", errors: checked.errors };
}

/** The answers as lines — "Who do you sell to?: B2B" — for the lead, the host's notice and the bookings list. */
export function answerLines(questions: Question[], answers: unknown): string[] {
  const given = parseAnswers(answers);
  return questions.flatMap((q) => {
    if (q.type === "HEADING") return [];
    const text = answerText(q, given[q.key]);
    return text ? [`${q.label}: ${text}`] : [];
  });
}

export type { Answers, Question };
