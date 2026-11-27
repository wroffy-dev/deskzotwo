import type { Clock } from "@/lib/time/zone";
import { officeDayMinutes, type OfficeHours } from "@/lib/hr/office-hours-rules";

/**
 * The internal help desk's rules (owner, 25 Nov 2026), without a database: how much a request holds somebody up, where it
 * stands, when it's due, and the words around them. Pure, so the server (./server.ts), the screens and check:desks read
 * the same answers.
 *
 * Customers' tickets are another thing (src/lib/tickets.ts): these are colleagues', numbered REQ-, and seen only by
 * whoever asked, the desk's own people and the super admin.
 */

export const formatRequestId = (seq: number) => `REQ-${String(seq).padStart(6, "0")}`;
export const requestPath = (seq: number) => `/help-desk/${formatRequestId(seq)}`;
/** Apart from /help-desk, so the menu's "Help desk" isn't lit on a desk's own list. */
export const deskPath = (seq: number) => `/desks/${seq}`;

/** "IT" is the IT desk in the menu; one already called a desk is left as it is. */
export const deskLabel = (name: string) => (/\bdesk$/i.test(name.trim()) ? name.trim() : `${name.trim()} desk`);

export const LEVELS = ["BLOCKED", "SLOW", "WHENEVER"] as const;
export type Level = (typeof LEVELS)[number];
export const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level);
/** What the person asking chooses. */
export const LEVEL_LABELS: Record<Level, string> = { BLOCKED: "I can't work", SLOW: "It slows me down", WHENEVER: "No hurry" };
/** The same, in the desk's list. */
export const LEVEL_SHORT: Record<Level, string> = { BLOCKED: "Can't work", SLOW: "Slows down", WHENEVER: "No hurry" };

/** What the desk may set; a request is otherwise OPEN (nobody has started), ASKED (for somebody's approval), or held. */
export const DESK_STATUSES = ["IN_PROGRESS", "WAITING", "ON_HOLD", "RESOLVED"] as const;
export type DeskStatus = (typeof DESK_STATUSES)[number];
export const isDeskStatus = (v: unknown): v is DeskStatus => DESK_STATUSES.includes(v as DeskStatus);
/** Not the desk's to see: waiting for approval first, or never approved. */
export const HELD: string[] = ["APPROVAL", "REJECTED"];
export const isHeld = (status: string) => HELD.includes(status);
/** Over. */
export const CLOSED: string[] = ["RESOLVED", "REJECTED"];
export const isClosed = (status: string) => CLOSED.includes(status);
/** While it's one of these the clock is stopped. */
export const PAUSED: ReadonlySet<string> = new Set(["WAITING", "ON_HOLD", "ASKED", "APPROVAL"]);

export const APPROVALS = ["NONE", "MANAGER"] as const;
export type TypeApproval = (typeof APPROVALS)[number];
export const APPROVAL_LABELS: Record<TypeApproval, string> = { NONE: "No approval", MANAGER: "Their manager approves first" };
export const COMMENT_MAX = 500;
export const STEPS_MAX = 30;
export const STEP_MAX = 160;

/** Where it stands, to whoever asked. */
export function statusWords(status: string, side: "requester" | "desk"): string {
  switch (status) {
    case "OPEN":
      return side === "requester" ? "Waiting for the desk" : "Not started";
    case "IN_PROGRESS":
      return "In progress";
    case "WAITING":
      return side === "requester" ? "Waiting for you" : "Waiting for them";
    case "ON_HOLD":
      return "On hold";
    case "APPROVAL":
    case "ASKED":
      return "Waiting for approval";
    case "REJECTED":
      return "Not approved";
    default:
      return "Resolved";
  }
}
export const statusTone = (status: string): "default" | "blue" | "amber" | "green" => (status === "RESOLVED" ? "green" : status === "IN_PROGRESS" ? "blue" : status === "ON_HOLD" || status === "REJECTED" ? "default" : "amber");
export const levelTone = (level: string): "default" | "blue" | "red" => (level === "BLOCKED" ? "red" : level === "SLOW" ? "blue" : "default");

export const ROUTINGS = ["POOL", "PERSON", "TURN"] as const;
export type Routing = (typeof ROUTINGS)[number];
export const ROUTING_LABELS: Record<Routing, string> = { POOL: "The whole desk, first to pick up", PERSON: "One person", TURN: "Each person in turn" };

// ─── Limits ──────────────────────────────────────────────────────────────────────────────────────

export const TITLE_MAX = 160;
export const BODY_MAX = 5000;
/** Requests one person may make in a day: a mistake or a script, not a busy morning, makes more. */
export const REQUESTS_PER_DAY = 30;
export const FILES_PER_MESSAGE = 5;
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
/** A resolved request is opened again by a reply for this long; after it, a new one is asked for. */
export const REOPEN_DAYS = 14;

// ─── Times ───────────────────────────────────────────────────────────────────────────────────────

/** A length of office time: so many hours, or so many office days. */
export type Span = { n: number; unit: "hours" | "days" };
export type Times = Record<Level, { reply: Span; fix: Span }>;

export const DEFAULT_TIMES: Times = {
  BLOCKED: { reply: { n: 1, unit: "hours" }, fix: { n: 1, unit: "days" } },
  SLOW: { reply: { n: 4, unit: "hours" }, fix: { n: 3, unit: "days" } },
  WHENEVER: { reply: { n: 1, unit: "days" }, fix: { n: 5, unit: "days" } },
};

function readSpan(value: unknown, fallback: Span): Span {
  const v = (value ?? {}) as Partial<Span>;
  const n = Number(v.n);
  return Number.isInteger(n) && n >= 1 && n <= 90 && (v.unit === "hours" || v.unit === "days") ? { n, unit: v.unit } : fallback;
}

/** A desk's times as kept; what isn't there, or isn't a time, as they come. */
export function readTimes(value: unknown): Times {
  const v = (value && typeof value === "object" ? value : {}) as Partial<Record<Level, { reply?: unknown; fix?: unknown }>>;
  return Object.fromEntries(LEVELS.map((l) => [l, { reply: readSpan(v[l]?.reply, DEFAULT_TIMES[l].reply), fix: readSpan(v[l]?.fix, DEFAULT_TIMES[l].fix) }])) as Times;
}

/** Times as typed in settings, or what's wrong with them. */
export function timesProblem(value: unknown): string | null {
  const v = (value ?? {}) as Partial<Record<Level, { reply?: Partial<Span>; fix?: Partial<Span> }>>;
  for (const l of LEVELS) {
    for (const key of ["reply", "fix"] as const) {
      const s = v[l]?.[key];
      const n = Number(s?.n);
      if (!Number.isInteger(n) || n < 1 || n > 90 || (s?.unit !== "hours" && s?.unit !== "days")) return `“${LEVEL_LABELS[l]}”: give each time as a whole number of hours or days, from 1 to 90.`;
    }
  }
  return null;
}

/** "4 working hours", "1 working day". */
export const spanWords = (s: Span) => `${s.n} working ${s.unit === "hours" ? "hour" : "day"}${s.n === 1 ? "" : "s"}`;

/** A span as minutes of office time; a day is the office's own, or 24 hours with no office hours set. */
export const spanMinutes = (s: Span, hours: OfficeHours | null) => (s.unit === "hours" ? s.n * 60 : s.n * (hours ? officeDayMinutes(hours) : 24 * 60));

/**
 * The moment so many minutes of office time after another: the company's hours each working day, Sundays and holidays
 * off — the reverse of `officeMinutesBetween` (src/lib/leads/response.ts), and the same days. With no hours set, the
 * clock's own minutes. A calendar of nothing but holidays gives up after two years, by the clock.
 */
export function addOfficeMinutes(from: Date, minutes: number, clock: Clock, hours: OfficeHours | null, holiday: (dayKey: string) => boolean): Date {
  if (!hours) return new Date(from.getTime() + minutes * 60_000);
  let left = minutes;
  let day = clock.dateKey(from);
  for (let i = 0; i < 740; i++) {
    const start = clock.startOfDay(day)!;
    const p = clock.parts(start);
    if (p.weekday !== 0 && !holiday(day)) {
      const open = clock.at(p.year, p.month, p.day, Math.floor(hours.startMinute / 60), hours.startMinute % 60);
      const shut = clock.at(p.year, p.month, p.day, Math.floor(hours.endMinute / 60), hours.endMinute % 60);
      const begin = Math.max(open.getTime(), from.getTime());
      const there = (shut.getTime() - begin) / 60_000;
      if (there > 0) {
        if (left <= there) return new Date(begin + left * 60_000);
        left -= there;
      }
    }
    day = clock.dateKey(new Date(start.getTime() + 36 * 3_600_000));
  }
  return new Date(from.getTime() + minutes * 60_000);
}

export type DueState = { kind: "reply" | "fix"; at: Date; late: boolean } | { kind: "paused" } | { kind: "done" } | { kind: "none" };

/** What a request owes next: its first reply, then being put right; nothing while the clock is stopped. */
export function dueState(r: { status: string; replyDueAt: Date | null; fixDueAt: Date | null; firstRepliedAt: Date | null }, now: Date): DueState {
  if (isClosed(r.status)) return { kind: "done" };
  if (PAUSED.has(r.status)) return { kind: "paused" };
  if (!r.firstRepliedAt && r.replyDueAt && (!r.fixDueAt || r.replyDueAt <= r.fixDueAt)) return { kind: "reply", at: r.replyDueAt, late: r.replyDueAt <= now };
  if (r.fixDueAt) return { kind: "fix", at: r.fixDueAt, late: r.fixDueAt <= now };
  return { kind: "none" };
}

/** Its due column: "Reply by 25 Nov 2026, 2:10 pm", "Reply overdue since …". */
export function dueWords(due: DueState, when: (at: Date) => string): string {
  switch (due.kind) {
    case "done":
      return "—";
    case "paused":
      return "Clock stopped";
    case "none":
      return "—";
    default:
      return due.late ? `${due.kind === "reply" ? "Reply" : "Fix"} overdue since ${when(due.at)}` : `${due.kind === "reply" ? "Reply by" : "Put right by"} ${when(due.at)}`;
  }
}
