/**
 * A project's questionnaire: the questions a project type asks its customer, and what counts as an answer (owner,
 * 16 Nov 2026 — "can't admin set questionnaire himself? stages himself?"). Pure, so the settings editor, the customer's
 * page and the server all read the same rules.
 *
 * Tolerant on the way in (`parseQuestions` never throws; a bad entry is dropped), strict on save
 * (`checkQuestionsForSave` says what is wrong), and strict on answers (`checkAnswers` takes only what was asked).
 */

export type QuestionType = "TEXT" | "TEXTAREA" | "SELECT" | "RADIO" | "MULTISELECT" | "CHECKBOX" | "NUMBER" | "DATE" | "EMAIL" | "PHONE" | "FILE" | "HEADING";

export type Question = {
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** The choice types only, one per entry. */
  options: string[];
  /** A line under the question; a heading's paragraph. */
  help: string | null;
};

export const QUESTION_TYPES: { type: QuestionType; label: string }[] = [
  { type: "TEXT", label: "Short answer" },
  { type: "TEXTAREA", label: "Paragraph" },
  { type: "SELECT", label: "Dropdown" },
  { type: "RADIO", label: "Single choice" },
  { type: "MULTISELECT", label: "Multiple choice" },
  { type: "CHECKBOX", label: "Tick box" },
  { type: "NUMBER", label: "Number" },
  { type: "DATE", label: "Date" },
  { type: "EMAIL", label: "Email address" },
  { type: "PHONE", label: "Phone number" },
  { type: "FILE", label: "File upload" },
  { type: "HEADING", label: "Section heading" },
];

const TYPES = new Set(QUESTION_TYPES.map((t) => t.type));
export const CHOICE_TYPES: QuestionType[] = ["SELECT", "RADIO", "MULTISELECT"];
export const isChoice = (t: QuestionType) => CHOICE_TYPES.includes(t);

export const LIMITS = { questions: 80, options: 40, label: 300, help: 500, option: 200, answer: 4000, filesPerQuestion: 5 } as const;

/** A file the customer attached: the project document it became. */
export type FileAnswer = { documentId: string; name: string; size: number };
export type AnswerValue = string | string[] | boolean | FileAnswer[];
export type Answers = Record<string, AnswerValue>;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A key from a label: "How many users?" → "how_many_users", made unique against `taken`. */
export function keyFor(label: string, taken: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "q";
  const start = /^[a-z]/.test(base) ? base : `q_${base}`;
  let key = start;
  for (let n = 2; taken.has(key); n++) key = `${start}_${n}`;
  taken.add(key);
  return key;
}

function cleanOptions(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const o = str(raw, LIMITS.option).replace(/\s+/g, " ");
    if (!o || seen.has(o.toLowerCase())) continue;
    seen.add(o.toLowerCase());
    out.push(o);
    if (out.length >= LIMITS.options) break;
  }
  return out;
}

/** Whatever is in the column, as questions; anything unusable left out. */
export function parseQuestions(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  const taken = new Set<string>();
  const out: Question[] = [];
  for (const raw of value.slice(0, LIMITS.questions)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = str(r.label, LIMITS.label);
    const type = TYPES.has(r.type as QuestionType) ? (r.type as QuestionType) : null;
    if (!label || !type) continue;
    const wanted = typeof r.key === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(r.key) && !taken.has(r.key) ? r.key : null;
    const key = wanted ?? keyFor(label, taken);
    if (wanted) taken.add(wanted);
    const options = isChoice(type) ? cleanOptions(r.options) : [];
    // A choice with nothing to choose is asked as a short answer rather than not at all.
    out.push({ key, label, type: isChoice(type) && options.length === 0 ? "TEXT" : type, required: type !== "HEADING" && r.required === true, options, help: str(r.help, LIMITS.help) || null });
  }
  return out;
}

/** The editor's list, checked: refused with a reason rather than repaired. Keys kept where given, made where not. */
export function checkQuestionsForSave(value: unknown): { ok: true; questions: Question[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "That isn't a list of questions." };
  if (value.length > LIMITS.questions) return { ok: false, error: `${LIMITS.questions} questions at most.` };
  const taken = new Set<string>();
  const out: Question[] = [];
  for (const [i, raw] of value.entries()) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const n = i + 1;
    const label = str(r.label, LIMITS.label);
    if (!label) return { ok: false, error: `Question ${n} has no wording.` };
    const type = r.type as QuestionType;
    if (!TYPES.has(type)) return { ok: false, error: `Question ${n} isn't a kind of question this knows.` };
    const options = isChoice(type) ? cleanOptions(r.options) : [];
    if (isChoice(type) && options.length < 2) return { ok: false, error: `"${label}" needs at least two options to choose from.` };
    const given = typeof r.key === "string" && /^[a-z][a-z0-9_]{0,59}$/.test(r.key) && !taken.has(r.key) ? r.key : null;
    if (given) taken.add(given);
    out.push({ key: given ?? keyFor(label, taken), label, type, required: type !== "HEADING" && r.required === true, options, help: str(r.help, LIMITS.help) || null });
  }
  return { ok: true, questions: out };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The customer's answers, checked against the questions they were sent. Only asked keys are kept; files are not taken
 * from here — they are added and removed one by one (src/actions/questionnaire-public.ts) and kept as they are.
 * `final`: the questions marked required must be answered — on submit, not on "Save for later".
 */
export function checkAnswers(
  questions: Question[],
  raw: unknown,
  kept: Answers,
  final: boolean,
): { ok: true; answers: Answers } | { ok: false; errors: Record<string, string> } {
  const given = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const answers: Answers = {};
  const errors: Record<string, string> = {};
  for (const q of questions) {
    if (q.type === "HEADING") continue;
    if (q.type === "FILE") {
      const files = Array.isArray(kept[q.key]) ? (kept[q.key] as FileAnswer[]) : [];
      if (files.length) answers[q.key] = files;
      else if (final && q.required) errors[q.key] = "Attach a file.";
      continue;
    }
    const v = given[q.key];
    if (q.type === "CHECKBOX") {
      if (v === true) answers[q.key] = true;
      else if (final && q.required) errors[q.key] = "Tick this to go on.";
      continue;
    }
    if (q.type === "MULTISELECT") {
      const picks = (Array.isArray(v) ? v : []).filter((p): p is string => typeof p === "string" && q.options.includes(p));
      if (picks.length) answers[q.key] = [...new Set(picks)];
      else if (final && q.required) errors[q.key] = "Choose at least one.";
      continue;
    }
    const text = typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, LIMITS.answer) : "";
    if (!text) {
      if (final && q.required) errors[q.key] = "This one needs an answer.";
      continue;
    }
    if ((q.type === "SELECT" || q.type === "RADIO") && !q.options.includes(text)) {
      errors[q.key] = "Choose one of the options.";
      continue;
    }
    if (q.type === "NUMBER" && !/^-?\d+(\.\d+)?$/.test(text)) {
      errors[q.key] = "A number, please.";
      continue;
    }
    if (q.type === "DATE" && (!DAY.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))) {
      errors[q.key] = "A date, please.";
      continue;
    }
    if (q.type === "EMAIL" && !EMAIL.test(text)) {
      errors[q.key] = "That doesn't look like an email address.";
      continue;
    }
    if (q.type === "PHONE" && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(text)) {
      errors[q.key] = "That doesn't look like a phone number.";
      continue;
    }
    answers[q.key] = q.type === "TEXT" || q.type === "EMAIL" || q.type === "PHONE" || q.type === "SELECT" || q.type === "RADIO" ? text.slice(0, 500) : text;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers };
}

/** The answers as stored, read back tolerantly. */
export function parseAnswers(value: unknown): Answers {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Answers = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) {
      const files = v.filter((f): f is FileAnswer => !!f && typeof f === "object" && typeof (f as FileAnswer).documentId === "string");
      out[k] = files.length ? files : v.filter((x): x is string => typeof x === "string");
    }
  }
  return out;
}

/** One answer as words, for the Requirements tab. Files are listed by the screen itself. */
export function answerText(q: Question, value: AnswerValue | undefined): string {
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "—";
  if (q.type === "CHECKBOX") return value === true ? "Yes" : "—";
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : v.name)).join(", ");
  return String(value);
}

/** How far a round has got, in words. */
export function roundState(r: { submittedAt: Date | string | null; closedAt: Date | string | null; savedAt: Date | string | null; openedAt: Date | string | null }): "SUBMITTED" | "CLOSED" | "STARTED" | "OPENED" | "SENT" {
  if (r.submittedAt) return "SUBMITTED";
  if (r.closedAt) return "CLOSED";
  if (r.savedAt) return "STARTED";
  if (r.openedAt) return "OPENED";
  return "SENT";
}

export const ROUND_STATE_LABELS = { SUBMITTED: "Answered", CLOSED: "Withdrawn", STARTED: "Started, not sent back", OPENED: "Opened", SENT: "Sent" } as const;

/** What a customer may attach: documents, sheets and pictures, each checked by its first bytes; 4 MB each. */
export const QUESTIONNAIRE_FILE = { maxBytes: 4 * 1024 * 1024, accept: ".pdf,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg" } as const;
