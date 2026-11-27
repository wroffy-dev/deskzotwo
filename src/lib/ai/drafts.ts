import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import type { TeammateKey } from "@/lib/ai/teammates";

/**
 * A teammate's drafts and what became of them (owner, 20 Nov 2026 — "upgrade our agents so they perform best", step 2).
 *
 *   · Recorded when a person decides: the draft as written beside what went — as written, lightly edited, rewritten —
 *     or set aside, and later whether the customer replied.
 *   · The scorecard reads it (how often a draft goes as written, how often it gets an answer).
 *   · The next drafts learn from it: a few of the workspace's own emails of that kind that went (nearly) as written and
 *     got a reply go into the prompt as examples, names, addresses and numbers taken out.
 *
 * Never in the way of the work: a failure to record is logged and the email goes all the same.
 */

export type DraftKind = "nurture.email" | "nurture.answer" | "collections.chase" | "reengage.email";
export type DraftOutcome = "AS_WRITTEN" | "LIGHT_EDIT" | "REWRITTEN" | "SKIPPED";

/** Lightly edited: at most this share of the words changed. */
export const LIGHT_EDIT_MAX = 0.2;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, 800);

/** How much of a text a person changed, 0 (none) to 1 (all of it): word edits over the longer text's words. */
export function changedShare(draft: string, sent: string): number {
  const a = words(draft);
  const b = words(sent);
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 1;
  // Levenshtein over words, two rows at a time.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return Math.min(1, prev[b.length]! / Math.max(a.length, b.length));
}

/** What became of a draft: the subject and body together, as the reader sees them. */
export function outcomeOf(draft: { subject: string; body: string }, sent: { subject: string; body: string } | null): { outcome: DraftOutcome; changed: number | null } {
  if (!sent) return { outcome: "SKIPPED", changed: null };
  const changed = changedShare(`${draft.subject}\n${draft.body}`, `${sent.subject}\n${sent.body}`);
  return { outcome: changed === 0 ? "AS_WRITTEN" : changed <= LIGHT_EDIT_MAX ? "LIGHT_EDIT" : "REWRITTEN", changed };
}

/** Records a decision on a draft — sent (as it went) or set aside — once a draft; deciding again replaces it. */
export async function recordDraft(input: {
  teammate: TeammateKey;
  kind: DraftKind;
  ref: string;
  userId: string;
  draft: { subject: string; body: string };
  sent: { subject: string; body: string } | null;
}): Promise<void> {
  const { outcome, changed } = outcomeOf(input.draft, input.sent);
  const data = {
    teammate: input.teammate,
    userId: input.userId,
    draftSubject: input.draft.subject.slice(0, 300),
    draftBody: input.draft.body.slice(0, 6000),
    sentSubject: input.sent?.subject.slice(0, 300) ?? null,
    sentBody: input.sent?.body.slice(0, 6000) ?? null,
    outcome,
    changed,
  };
  try {
    await db.aiDraftRecord.upsert({ where: { kind_ref: { kind: input.kind, ref: input.ref } }, create: { kind: input.kind, ref: input.ref, ...data }, update: data, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[drafts] recording a draft failed", err instanceof Error ? err.message : err);
  }
}

/** A customer answered the email this draft became. */
export async function noteReplied(kind: DraftKind, ref: string, at = new Date()): Promise<void> {
  try {
    await db.aiDraftRecord.updateMany({ where: { kind, ref, repliedAt: null, outcome: { not: "SKIPPED" } }, data: { repliedAt: at } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[drafts] noting a reply failed", err instanceof Error ? err.message : err);
  }
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NUMBER = /\+?\(?\d[\d\s().-]{5,}\d/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An example's text with what isn't the writing taken out: addresses, numbers, links, and the names given. */
export function scrubExample(text: string, names: string[]): string {
  let out = text
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(EMAIL, "[email]")
    .replace(NUMBER, (m) => (m.replace(/\D/g, "").length >= 7 ? "[number]" : m));
  for (const name of names.map((n) => n.trim()).filter((n) => n.length >= 3)) out = out.replace(new RegExp(escape(name), "gi"), "[company]");
  return out.slice(0, 1500);
}

/**
 * Up to `take` of the workspace's own emails of a kind that went as written or lightly edited and got a reply, newest
 * first — as a teammate's examples of what works here. Their company names are taken out too.
 */
export async function examplesFor(kind: DraftKind, take = 3, since = new Date(Date.now() - 180 * 86_400_000)): Promise<{ subject: string; body: string }[]> {
  try {
    const rows = await db.aiDraftRecord.findMany({
      where: { kind, repliedAt: { not: null }, outcome: { in: ["AS_WRITTEN", "LIGHT_EDIT"] }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take,
      select: { ref: true, sentSubject: true, sentBody: true },
    });
    if (!rows.length) return [];
    const names = await companyNamesFor(kind, rows.map((r) => r.ref));
    return rows.map((r) => ({ subject: scrubExample(r.sentSubject ?? "", names), body: scrubExample(r.sentBody ?? "", names) }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The companies the examples were written to, to take their names out. */
async function companyNamesFor(kind: DraftKind, refs: string[]): Promise<string[]> {
  if (kind === "collections.chase") {
    return (await db.collectionChase.findMany({ where: { id: { in: refs } }, select: { company: { select: { name: true } } } })).map((c) => c.company.name);
  }
  if (kind === "reengage.email") {
    return (await db.reengageEmail.findMany({ where: { id: { in: refs } }, select: { company: { select: { name: true } } } })).map((e) => e.company.name);
  }
  if (kind === "nurture.email") {
    return (await db.nurtureTouch.findMany({ where: { id: { in: refs } }, select: { enrolment: { select: { lead: { select: { company: { select: { name: true } } } } } } } })).map((t) => t.enrolment.lead.company.name);
  }
  return (await db.nurtureReply.findMany({ where: { id: { in: refs } }, select: { enrolment: { select: { lead: { select: { company: { select: { name: true } } } } } } } })).map((t) => t.enrolment.lead.company.name);
}

/** The examples as a few lines of a prompt — or nothing when there are none yet. */
export function examplesBlock(examples: { subject: string; body: string }[]): string {
  if (!examples.length) return "";
  return [
    "",
    "Emails of this kind from this team that customers answered — match their tone and length, never their facts:",
    ...examples.map((e, i) => `--- Example ${i + 1}\nSubject: ${e.subject}\n${e.body}`),
    "---",
  ].join("\n");
}

// ─── The scorecard ────────────────────────────────────────────────────────────────────────────────────────────────

export type DraftScore = { decided: number; asWritten: number; lightEdit: number; rewritten: number; skipped: number; sent: number; replied: number };
export type TeammateScore = {
  teammate: TeammateKey;
  drafts: DraftScore | null;
  /** Kabir: chats he answered, and of them handed to a person. Priya: questions, and of them passed to HR. */
  handled: { total: number; handedOn: number } | null;
  feedback: { good: number; bad: number; reasons: string[] };
};

const emptyScore = (): DraftScore => ({ decided: 0, asWritten: 0, lightEdit: 0, rewritten: 0, skipped: 0, sent: 0, replied: 0 });

/** Each teammate's last 30 days: drafts and what became of them, what they handed on, and the thumbs. */
export async function scorecard(now = new Date(), days = 30): Promise<TeammateScore[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [drafts, feedback, priya, kabir] = await Promise.all([
    db.aiDraftRecord.findMany({ where: { createdAt: { gte: since } }, select: { teammate: true, outcome: true, repliedAt: true } }).catch((err) => (notMigratedYet(err) ? [] : Promise.reject(err))),
    db.aiFeedback.findMany({ where: { updatedAt: { gte: since } }, select: { teammate: true, good: true, reason: true }, orderBy: { updatedAt: "desc" } }).catch((err) => (notMigratedYet(err) ? [] : Promise.reject(err))),
    db.hrDeskQuestion
      .groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: { _all: true } })
      .catch(() => [] as { status: string; _count: { _all: number } }[]),
    kabirHandled(since),
  ]);
  const byTeammate = new Map<TeammateKey, DraftScore>();
  for (const d of drafts) {
    const s = byTeammate.get(d.teammate as TeammateKey) ?? emptyScore();
    s.decided += 1;
    if (d.outcome === "AS_WRITTEN") s.asWritten += 1;
    else if (d.outcome === "LIGHT_EDIT") s.lightEdit += 1;
    else if (d.outcome === "REWRITTEN") s.rewritten += 1;
    else s.skipped += 1;
    if (d.outcome !== "SKIPPED") s.sent += 1;
    if (d.repliedAt) s.replied += 1;
    byTeammate.set(d.teammate as TeammateKey, s);
  }
  const thumbs = (key: TeammateKey) => {
    const mine = feedback.filter((f) => f.teammate === key);
    return { good: mine.filter((f) => f.good).length, bad: mine.filter((f) => !f.good).length, reasons: mine.filter((f) => !f.good && f.reason).map((f) => f.reason!).slice(0, 5) };
  };
  const hr = priya as { status: string; _count: { _all: number } }[];
  const priyaTotal = hr.reduce((n: number, g) => n + g._count._all, 0);
  const priyaHanded = hr.filter((g) => g.status === "WITH_HR" || g.status === "HR_ANSWERED").reduce((n: number, g) => n + g._count._all, 0);
  const keys: TeammateKey[] = ["tara", "arjun", "kabir", "priya"];
  return keys.map((teammate) => ({
    teammate,
    drafts: teammate === "tara" || teammate === "arjun" ? (byTeammate.get(teammate) ?? emptyScore()) : null,
    handled: teammate === "priya" ? { total: priyaTotal, handedOn: priyaHanded } : teammate === "kabir" ? kabir : null,
    feedback: thumbs(teammate),
  }));
}

/** Kabir's chats in the window: those he answered, and of them the ones a person took over after him. */
async function kabirHandled(since: Date): Promise<{ total: number; handedOn: number }> {
  try {
    const answered = await db.conversation.findMany({
      where: { messages: { some: { author: "BOT", createdAt: { gte: since } } } },
      select: { id: true, messages: { where: { author: { in: ["BOT", "AGENT"] } }, orderBy: { createdAt: "asc" }, select: { author: true } } },
      take: 2000,
    });
    const handedOn = answered.filter((c) => {
      const firstBot = c.messages.findIndex((m) => m.author === "BOT");
      return firstBot >= 0 && c.messages.slice(firstBot).some((m) => m.author === "AGENT");
    }).length;
    return { total: answered.length, handedOn };
  } catch (err) {
    if (notMigratedYet(err)) return { total: 0, handedOn: 0 };
    throw err;
  }
}

// ─── Thumbs up or down ────────────────────────────────────────────────────────────────────────────────────────────

/** A person's thumbs on one draft or answer — pressing again changes it, `good: null` takes it back. */
export async function setFeedback(input: { teammate: TeammateKey; kind: string; ref: string; userId: string; good: boolean | null; reason?: string | null }): Promise<void> {
  const where = { kind_ref_userId: { kind: input.kind, ref: input.ref, userId: input.userId } };
  if (input.good === null) {
    await db.aiFeedback.deleteMany({ where: { kind: input.kind, ref: input.ref, userId: input.userId } });
    return;
  }
  const reason = input.reason?.replace(/\s+/g, " ").trim().slice(0, 300) || null;
  await db.aiFeedback.upsert({ where, create: { teammate: input.teammate, kind: input.kind, ref: input.ref, userId: input.userId, good: input.good, reason }, update: { good: input.good, reason }, select: { id: true } });
}

/** This person's thumbs on these things, by ref. */
export async function feedbackOf(kind: string, refs: string[], userId: string): Promise<Record<string, boolean>> {
  if (!refs.length) return {};
  try {
    const rows = await db.aiFeedback.findMany({ where: { kind, ref: { in: refs }, userId }, select: { ref: true, good: true } });
    return Object.fromEntries(rows.map((r) => [r.ref, r.good]));
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

/** A draft already recorded as going (held for the morning) and then set aside after all. */
export async function markSkipped(kind: DraftKind, ref: string): Promise<void> {
  try {
    await db.aiDraftRecord.updateMany({ where: { kind, ref }, data: { outcome: "SKIPPED", sentSubject: null, sentBody: null, changed: null } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[drafts] marking a draft set aside failed", err instanceof Error ? err.message : err);
  }
}
