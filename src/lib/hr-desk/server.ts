import { styled } from "@/lib/ai/house-style";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { copilotConfig } from "@/lib/copilot/settings";
import { aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { getOrganisation } from "@/lib/organisation";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { searchKnowledge } from "@/lib/ai-knowledge/search";
import { teammateWork } from "@/lib/ai/teammate-work";
import { HR_ANSWER_STEPS } from "@/lib/ai/teammate-steps";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";
import { leaveBalances, myLeaveRequests } from "@/actions/leave";
import { shortLeaveOverview } from "@/actions/short-leave";
import { myDays } from "@/actions/attendance";
import { myPayslips } from "@/actions/payroll";
import {
  KEEP_ANSWERED_DAYS,
  LINKS,
  PROPOSE_ANSWER,
  QUESTIONS_PER_DAY,
  QUESTION_MAX,
  answerSchema,
  askPrompt,
  factsText,
  handedNote,
  hrSystem,
  namesMoney,
  type Facts,
  type LinkKey,
} from "@/lib/hr-desk/rules";

/**
 * Priya, the HR desk (owner, 20 Nov 2026 — the words and rules are ./rules.ts).
 *
 *   · Off until an admin switches it on (Settings › Deskzo AI), with Deskzo AI on. Then anybody with My HR may ask her —
 *     "Use Deskzo AI" isn't needed: she is the company's HR desk, not a person's assistant. Each question is a model
 *     turn charged to the person asking, inside their daily Deskzo AI limit and QUESTIONS_PER_DAY.
 *   · She reads only the asker's own records, through the same reads My HR uses (so module switches and hidden payslips
 *     hold), and only the AI Knowledge files chosen for her. No money and nobody else's details go to the model; an
 *     answer that names a sum anyway is not shown.
 *   · What she can't answer — or when the person asks for a person — goes to HR: the people named in settings, else
 *     everybody who manages people records (`hr.manage`), told in her voice. HR answers on People › HR desk, and the
 *     person is told. HR sees only what was passed to them.
 */

const DAY = 86_400_000;

export class HrDeskRefusal extends Error {}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type HrDeskConfig = { enabled: boolean; handTo: string[]; migrated: boolean };

export async function hrDeskConfig(): Promise<HrDeskConfig> {
  try {
    const row = await db.hrDeskSettings.findUnique({ where: { id: "global" }, select: { enabled: true, handTo: true } });
    return { enabled: row?.enabled ?? false, handTo: row?.handTo ?? [], migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { enabled: false, handTo: [], migrated: false };
    throw err;
  }
}

export async function saveHrDeskConfig(input: { enabled: boolean; handTo: string[]; fileIds: string[] }, userId: string): Promise<void> {
  const before = await hrDeskConfig();
  await db.$transaction(async (tx) => {
    await tx.hrDeskSettings.upsert({
      where: { id: "global" },
      create: { id: "global", enabled: input.enabled, handTo: input.handTo, onSince: input.enabled ? new Date() : null, updatedById: userId },
      update: { enabled: input.enabled, handTo: input.handTo, ...(input.enabled && !before.enabled ? { onSince: new Date() } : {}), updatedById: userId },
      select: { id: true },
    });
    await tx.hrDeskFile.deleteMany({ where: { fileId: { notIn: input.fileIds } } });
    const have = new Set((await tx.hrDeskFile.findMany({ select: { fileId: true } })).map((f) => f.fileId));
    const add = input.fileIds.filter((id) => !have.has(id));
    if (add.length) await tx.hrDeskFile.createMany({ data: add.map((fileId) => ({ fileId, addedById: userId })), skipDuplicates: true });
  });
}

/** The AI Knowledge files chosen for her. */
export async function hrDeskFileIds(): Promise<string[]> {
  try {
    return (await db.hrDeskFile.findMany({ select: { fileId: true } })).map((f) => f.fileId);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Who answers what she passes on: the people named, still here and managing people records — else all who do. */
export async function hrPeople(handTo: string[]): Promise<string[]> {
  const members = await db.user.findMany({ where: { active: true, kind: "MEMBER", ...(handTo.length ? { id: { in: handTo } } : {}) }, select: { id: true } });
  const out: string[] = [];
  for (const m of members) if (await can(m.id, "hr.manage")) out.push(m.id);
  if (out.length || !handTo.length) return out;
  return hrPeople([]);
}

/** Whether she answers here, and — when she doesn't — why, in words for the person asking. */
export async function hrDeskClosed(): Promise<string | null> {
  const config = await hrDeskConfig();
  if (!config.enabled) return "The HR desk isn't switched on here.";
  if (!(await copilotConfig()).enabled) return "The HR desk is resting — Deskzo AI is switched off for this workspace.";
  return null;
}

// ─── Their facts ──────────────────────────────────────────────────────────────────────────────────────────────────

const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const quiet = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    // A module off, or not theirs: that part simply isn't there.
    return null;
  }
};

/**
 * What she may know about the person asking — read as them (they are the session), through the reads My HR uses. Never
 * a figure of money, a number on an ID, or anybody else.
 */
export async function gatherFacts(userId: string, now = new Date()): Promise<Facts> {
  const clock = await workspaceClock();
  const todayKey = clock.today(now);
  const today = new Date(`${todayKey}T00:00:00Z`);
  const monthStart = `${todayKey.slice(0, 8)}01`;
  const [balances, requests, holidays, short, month, slips] = await Promise.all([
    quiet(() => leaveBalances(userId)),
    quiet(() => myLeaveRequests()),
    quiet(() => db.holiday.findMany({ where: { date: { gte: today, lte: new Date(today.getTime() + 120 * DAY) } }, orderBy: { date: "asc" }, take: 8, select: { name: true, date: true, optional: true } })),
    quiet(() => shortLeaveOverview()),
    quiet(() => myDays({ from: monthStart, to: todayKey })),
    quiet(() => myPayslips()),
  ]);
  const counts: Record<string, number> = {};
  const unrecorded: string[] = [];
  for (const d of month ?? []) {
    if (d.status) counts[d.status.toLowerCase().replace(/_/g, " ")] = (counts[d.status.toLowerCase().replace(/_/g, " ")] ?? 0) + 1;
    else if (d.offDay) counts[d.offDay] = (counts[d.offDay] ?? 0) + 1;
    else if (d.date < todayKey) unrecorded.push(formatCalendarDay(d.date));
  }
  const live = (requests ?? []).filter(
    (r) => (r.status === "PENDING" || new Date(r.toDate).getTime() >= today.getTime()) && r.status !== "CANCELLED" && r.status !== "REJECTED",
  );
  const latest = slips?.[0];
  return {
    today: WEEKDAY.format(today),
    leave: balances ? balances.map((b) => ({ name: b.name, code: b.code, available: b.available, pending: b.pending, paid: b.paid })) : null,
    requests: live.slice(0, 6).map((r) => ({ type: r.type.name, from: formatCalendarDay(r.fromDate), to: formatCalendarDay(r.toDate), days: Number(r.days), status: r.status })),
    holidays: holidays ? holidays.map((h) => ({ name: h.name, on: WEEKDAY.format(h.date), optional: h.optional })) : null,
    shortLeave: short ? { used: short.usedThisMonth, perMonth: short.policy.perMonth, maxMinutes: short.policy.maxMinutes } : null,
    attendance: month ? { counts, unrecorded: unrecorded.slice(0, 10) } : null,
    payslips: latest ? { latest: `${MONTHS[latest.run.month - 1]} ${latest.run.year}`, count: slips!.length } : null,
  };
}

// ─── Asking ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type QuestionView = {
  id: string;
  question: string;
  answer: string | null;
  link: { href: string; label: string } | null;
  status: string;
  hrAnswer: string | null;
  hrAnsweredBy: string | null;
  askedAt: string;
};

async function view(id: string): Promise<QuestionView | null> {
  const q = await db.hrDeskQuestion.findUnique({ where: { id } });
  if (!q) return null;
  const by = q.hrAnsweredById ? await db.user.findUnique({ where: { id: q.hrAnsweredById }, select: { name: true } }) : null;
  const link = q.link && q.link in LINKS ? LINKS[q.link as LinkKey] : null;
  return { id: q.id, question: q.question, answer: q.answer, link: link ? { ...link } : null, status: q.status, hrAnswer: q.hrAnswer, hrAnsweredBy: by?.name ?? null, askedAt: q.createdAt.toISOString() };
}

/** Passes a question to HR — the people named, else everybody who manages people records — in her voice. */
async function passToHr(questionId: string, askerId: string, question: string): Promise<void> {
  const config = await hrDeskConfig();
  const people = (await hrPeople(config.handTo)).filter((id) => id !== askerId);
  const asker = await db.user.findUnique({ where: { id: askerId }, select: { name: true } });
  const name = (await teammate("priya")).name;
  for (const userId of people) {
    await notifyUser({ userId, type: "HR_DESK_QUESTION", title: noteFrom(name, "a question for you — I couldn't answer it"), message: handedNote(asker?.name ?? "", question), link: "/people/hr-desk" }).catch(() => {});
  }
}

/**
 * Somebody asks Priya. The question is kept, she answers from their own records and her guides, and what she can't
 * answer is passed to HR at once. Throws HrDeskRefusal with words.
 */
export async function askPriya(userId: string, rawQuestion: string, now = new Date()): Promise<QuestionView> {
  const closed = await hrDeskClosed();
  if (closed) throw new HrDeskRefusal(closed);
  const question = rawQuestion.replace(/\s+/g, " ").trim().slice(0, QUESTION_MAX);
  if (question.length < 3) throw new HrDeskRefusal("Ask a question — a few words is enough.");
  const clock = await workspaceClock();
  const midnight = clock.startOfDay(clock.today(now)) ?? new Date(now.getTime() - DAY);
  if ((await db.hrDeskQuestion.count({ where: { askerId: userId, createdAt: { gte: midnight } } })) >= QUESTIONS_PER_DAY) {
    throw new HrDeskRefusal(`That's ${QUESTIONS_PER_DAY} questions today — the HR desk opens again tomorrow. HR can still be reached directly.`);
  }
  // Answered-by-her ones past their time go, now and then.
  await db.hrDeskQuestion.deleteMany({ where: { status: "ANSWERED", createdAt: { lt: new Date(now.getTime() - KEEP_ANSWERED_DAYS * DAY) } } }).catch(() => {});

  // The same words again within a minute — a double click, or Enter and the button — is the question already asked
  // (owner, 23 Nov 2026 — "ask button has double clicking issue"): never a second one for HR or the model.
  const again = await db.hrDeskQuestion.findFirst({ where: { askerId: userId, question, createdAt: { gte: new Date(now.getTime() - 60_000) } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (again) {
    const same = await view(again.id);
    if (same) return same;
  }

  const row = await db.hrDeskQuestion.create({ data: { askerId: userId, question, status: "FAILED" }, select: { id: true } });
  const [org, earlier, name] = await Promise.all([
    getOrganisation(),
    // The last two of this conversation — within the hour — so "and next month?" reads right.
    db.hrDeskQuestion.findMany({
      where: { askerId: userId, id: { not: row.id }, answer: { not: null }, createdAt: { gte: new Date(now.getTime() - 60 * 60_000) } },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { question: true, answer: true },
    }),
    teammate("priya").then((t) => t.name),
  ]);

  try {
    const result = await teammateWork(
      { teammate: "priya", userId, kind: "hr.answer", subject: `hr:${row.id}`, label: question.slice(0, 80), href: "/people/me#ask", steps: HR_ANSWER_STEPS },
      async (work) => {
        const facts = factsText(await gatherFacts(userId, now));
        await work.step(1);
        const guides = await searchKnowledge(question, 4, { forHrDesk: true });
        await work.step(2);
        const prompt = askPrompt({ facts, guides, earlier: earlier.reverse().map((e) => ({ question: e.question, answer: e.answer! })), question });
        let outcome;
        try {
          outcome = await aiTurn({ userId, feature: "hr.answer", system: await styled(hrSystem(name, org.tradeName || org.legalName || "the company"), { signOff: false }), history: [{ role: "user", text: prompt }], tools: [PROPOSE_ANSWER] });
        } catch (err) {
          if (err instanceof AiRefusal) throw new HrDeskRefusal(err.message);
          throw err;
        }
        const call = outcome.toolCalls.find((c) => c.name === PROPOSE_ANSWER.name);
        const read = call ? answerSchema.safeParse(call.input) : null;
        if (!read?.success) throw new HrDeskRefusal(`${name} couldn't put an answer together — it's gone to HR instead.`);
        // A sum of money she was never given is made up: not shown, and HR takes it.
        if (namesMoney(read.data.answer)) return { answer: `I can't see salaries or amounts, so I've passed this to HR — they'll reply here.`, handToHr: true, topic: read.data.topic, link: "MY_HR" as LinkKey };
        return read.data;
      },
      (r) => (r.handToHr ? "Passed to HR" : "Answered"),
    );
    await db.hrDeskQuestion.update({
      where: { id: row.id },
      data: { answer: result.answer, topic: result.topic, link: result.link, status: result.handToHr ? "WITH_HR" : "ANSWERED", handedAt: result.handToHr ? now : null },
    });
    if (result.handToHr) await passToHr(row.id, userId, question);
  } catch (err) {
    if (!(err instanceof HrDeskRefusal)) {
      console.error("[hr-desk] answering failed", err instanceof Error ? err.message : err);
    }
    // Credits out, AI paused, no sense made: the question still reaches a person.
    const words = err instanceof HrDeskRefusal ? err.message : "Something went wrong answering this.";
    await db.hrDeskQuestion.update({ where: { id: row.id }, data: { answer: `${words} I've passed your question to HR — they'll reply here.`, status: "WITH_HR", handedAt: now } });
    await passToHr(row.id, userId, question);
  }
  return (await view(row.id))!;
}

/** The person asks for a person instead: their question goes to HR. Only their own, and only one Priya answered. */
export async function askForAPerson(questionId: string, userId: string, now = new Date()): Promise<QuestionView> {
  const q = await db.hrDeskQuestion.findUnique({ where: { id: questionId } });
  if (!q || q.askerId !== userId) throw new HrDeskRefusal("That question isn't there any more.");
  if (q.status !== "ANSWERED") throw new HrDeskRefusal(q.status === "HR_ANSWERED" ? "HR has answered it already." : "It's with HR already.");
  await db.hrDeskQuestion.update({ where: { id: q.id }, data: { status: "WITH_HR", handedAt: now } });
  await passToHr(q.id, userId, q.question);
  return (await view(q.id))!;
}

/** This person's own questions, newest first. */
export async function myQuestions(userId: string, take = 8): Promise<QuestionView[]> {
  try {
    const rows = await db.hrDeskQuestion.findMany({ where: { askerId: userId }, orderBy: { createdAt: "desc" }, take, select: { id: true } });
    return (await Promise.all(rows.map((r) => view(r.id)))).filter((v): v is QuestionView => !!v);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

// ─── HR's side ────────────────────────────────────────────────────────────────────────────────────────────────────

export type InboxItem = {
  id: string;
  askerName: string;
  askerSeq: number | null;
  question: string;
  priyaAnswer: string | null;
  status: string;
  askedAt: string;
  handedAt: string | null;
  hrAnswer: string | null;
  hrAnsweredBy: string | null;
};

/** What was passed to HR: waiting first (oldest first), then the last fortnight's answered. */
export async function hrInbox(now = new Date()): Promise<InboxItem[]> {
  try {
    const rows = await db.hrDeskQuestion.findMany({
      where: { OR: [{ status: "WITH_HR" }, { status: "HR_ANSWERED", hrAnsweredAt: { gte: new Date(now.getTime() - 14 * DAY) } }] },
      orderBy: [{ status: "desc" }, { handedAt: "asc" }],
      take: 200,
      include: { asker: { select: { name: true, userSeq: true } } },
    });
    const answerers = new Map(
      (await db.user.findMany({ where: { id: { in: rows.flatMap((r) => (r.hrAnsweredById ? [r.hrAnsweredById] : [])) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    return rows
      .map((r) => ({
        id: r.id,
        askerName: r.asker.name,
        askerSeq: r.asker.userSeq ?? null,
        question: r.question,
        priyaAnswer: r.answer,
        status: r.status,
        askedAt: r.createdAt.toISOString(),
        handedAt: r.handedAt?.toISOString() ?? null,
        hrAnswer: r.hrAnswer,
        hrAnsweredBy: r.hrAnsweredById ? (answerers.get(r.hrAnsweredById) ?? null) : null,
      }))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "WITH_HR" ? -1 : 1));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** HR answers a question passed to them; the person who asked is told. */
export async function answerAsHr(questionId: string, hrUserId: string, text: string, now = new Date()): Promise<void> {
  const answer = text.trim().slice(0, 3000);
  if (answer.length < 2) throw new HrDeskRefusal("Write the answer first.");
  const q = await db.hrDeskQuestion.findUnique({ where: { id: questionId } });
  if (!q || q.status !== "WITH_HR") throw new HrDeskRefusal(q?.status === "HR_ANSWERED" ? "Somebody in HR has answered it already." : "That question isn't waiting for HR.");
  if (q.askerId === hrUserId) throw new HrDeskRefusal("That's your own question — somebody else in HR answers it.");
  await db.hrDeskQuestion.update({ where: { id: q.id }, data: { status: "HR_ANSWERED", hrAnswer: answer, hrAnsweredById: hrUserId, hrAnsweredAt: now } });
  const who = (await db.user.findUnique({ where: { id: hrUserId }, select: { name: true } }))?.name ?? "HR";
  await notifyUser({ userId: q.askerId, type: "HR_DESK_ANSWERED", title: `${who} from HR answered your question`, message: answer.slice(0, 300), link: "/people/me#ask" }).catch(() => {});
  await recordAudit({ userId: hrUserId, action: "UPDATE", entityType: "HrDeskQuestion", entityId: q.id, entityLabel: "Answered a question passed on by the HR desk" });
}

export type HrDeskReport = { asked: number; answered: number; passed: number; hrAnswered: number; waiting: number };

/** The last 30 days, for the settings card. */
export async function hrDeskReport(now = new Date()): Promise<HrDeskReport> {
  const since = new Date(now.getTime() - 30 * DAY);
  try {
    const [asked, answered, passed, hrAnswered, waiting] = await Promise.all([
      db.hrDeskQuestion.count({ where: { createdAt: { gte: since } } }),
      db.hrDeskQuestion.count({ where: { createdAt: { gte: since }, status: "ANSWERED" } }),
      db.hrDeskQuestion.count({ where: { createdAt: { gte: since }, handedAt: { not: null } } }),
      db.hrDeskQuestion.count({ where: { hrAnsweredAt: { gte: since } } }),
      db.hrDeskQuestion.count({ where: { status: "WITH_HR" } }),
    ]);
    return { asked, answered, passed, hrAnswered, waiting };
  } catch (err) {
    if (notMigratedYet(err)) return { asked: 0, answered: 0, passed: 0, hrAnswered: 0, waiting: 0 };
    throw err;
  }
}
