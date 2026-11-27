import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { leadPath } from "@/lib/record-links";
import type { TeammateKey } from "@/lib/ai/teammates";
import { checkInsWaitingFor } from "@/lib/reengage/server";

/**
 * "Waiting for you" (owner, 20 Nov 2026 — "upgrade our agents so they… are easily accessible", step 1): everything an AI
 * teammate has left for this person to decide, in one list — Tara's follow-ups, the answers she drafted to replies and
 * (step 4) her check-ins to their quiet customers,
 * Arjun's chase emails and the customers' replies he read, the HR questions Priya passed on, and the chats Kabir handed
 * over that the customer is waiting on. Each only what is this person's: their own leads' nurtures, the chases they
 * drafted or sent, HR's questions for whoever answers them, the chats given to them. Nothing here does anything; each
 * item opens where it is decided.
 */

export type WaitingItem = {
  teammate: TeammateKey;
  /** What it is, in words: "Email 2 to Acme — check and send". */
  title: string;
  detail: string | null;
  href: string;
  /** When it started waiting (ISO), oldest first in the list. */
  at: string;
  /**
   * An email a person checks and sends — decided in place on the phone (owner, 22 Nov 2026 — src/lib/app/waiting.ts):
   * which kind, and its own id. Anything else opens where it's decided.
   */
  decide?: { kind: WaitingDecideKind; id: string };
};

export type WaitingDecideKind = "nurture" | "checkin" | "chase";

export type WaitingForYou = { items: WaitingItem[]; total: number; byTeammate: Partial<Record<TeammateKey, number>> };

const DAY = 86_400_000;
const PER_SOURCE = 8;

async function quietly<T>(fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (notMigratedYet(err)) return empty;
    throw err;
  }
}

type Counted = { items: WaitingItem[]; count: number };
const none: Counted = { items: [], count: 0 };

/** Tara: emails waiting for their owner, the answers she drafted to replies, and her check-ins to quiet customers. */
async function tara(userId: string): Promise<Counted> {
  const [drafts, draftCount, answers, answerCount, checkIns] = await Promise.all([
    quietly(
      () =>
        db.nurtureTouch.findMany({
          where: { status: "WAITING", enrolment: { ownerId: userId, status: "ACTIVE" } },
          orderBy: { createdAt: "asc" },
          take: PER_SOURCE,
          select: { id: true, step: true, subject: true, createdAt: true, enrolment: { select: { lead: { select: { leadSeq: true, company: { select: { name: true } } } } } } },
        }),
      [],
    ),
    quietly(() => db.nurtureTouch.count({ where: { status: "WAITING", enrolment: { ownerId: userId, status: "ACTIVE" } } }), 0),
    quietly(
      () =>
        db.nurtureReply.findMany({
          where: { answeredAt: null, answerBody: { not: null }, fromEmail: { not: null }, createdAt: { gte: new Date(Date.now() - 14 * DAY) }, enrolment: { ownerId: userId } },
          orderBy: { createdAt: "asc" },
          take: PER_SOURCE,
          select: { fromName: true, createdAt: true, enrolment: { select: { lead: { select: { leadSeq: true, company: { select: { name: true } } } } } } },
        }),
      [],
    ),
    quietly(() => db.nurtureReply.count({ where: { answeredAt: null, answerBody: { not: null }, fromEmail: { not: null }, createdAt: { gte: new Date(Date.now() - 14 * DAY) }, enrolment: { ownerId: userId } } }), 0),
    checkInsWaitingFor(userId, PER_SOURCE),
  ]);
  return {
    items: [
      ...answers.map((r) => ({
        teammate: "tara" as const,
        title: `${r.fromName ?? "A customer"} replied — an answer is drafted`,
        detail: r.enrolment.lead.company.name,
        href: leadPath(r.enrolment.lead.leadSeq),
        at: r.createdAt.toISOString(),
      })),
      ...drafts.map((t) => ({
        teammate: "tara" as const,
        title: `Follow-up ${t.step + 1} to ${t.enrolment.lead.company.name} — check and send`,
        detail: t.subject,
        href: leadPath(t.enrolment.lead.leadSeq),
        at: t.createdAt.toISOString(),
        decide: { kind: "nurture" as const, id: t.id },
      })),
      ...checkIns.items.map((c) => ({
        teammate: "tara" as const,
        title: `Check-in to ${c.company} — quiet a while; check and send`,
        detail: c.subject,
        href: c.href,
        at: c.at.toISOString(),
        decide: { kind: "checkin" as const, id: c.id },
      })),
    ],
    count: draftCount + answerCount + checkIns.count,
  };
}

/** Arjun: chase emails they asked for, waiting to be sent; customers' replies to their chases he read, not acted on. */
async function arjun(userId: string): Promise<Counted> {
  const mine = { OR: [{ sentById: userId }, { sentById: null, createdById: userId }] };
  const [chases, chaseCount, replies, replyCount] = await Promise.all([
    quietly(
      () =>
        db.collectionChase.findMany({
          where: { createdById: userId, status: "WAITING", createdAt: { gte: new Date(Date.now() - 14 * DAY) } },
          orderBy: { createdAt: "asc" },
          take: PER_SOURCE,
          select: { id: true, createdAt: true, company: { select: { name: true } } },
        }),
      [],
    ),
    quietly(() => db.collectionChase.count({ where: { createdById: userId, status: "WAITING", createdAt: { gte: new Date(Date.now() - 14 * DAY) } } }), 0),
    quietly(
      () =>
        db.collectionReply.findMany({
          where: { status: "OPEN", reading: { not: null }, chase: mine },
          orderBy: { createdAt: "asc" },
          take: PER_SOURCE,
          select: { fromName: true, summary: true, createdAt: true, chase: { select: { company: { select: { name: true } } } } },
        }),
      [],
    ),
    quietly(() => db.collectionReply.count({ where: { status: "OPEN", reading: { not: null }, chase: mine } }), 0),
  ]);
  return {
    items: [
      ...replies.map((r) => ({
        teammate: "arjun" as const,
        title: `${r.chase.company.name} replied about payment`,
        detail: r.summary ?? r.fromName,
        href: "/collections",
        at: r.createdAt.toISOString(),
      })),
      ...chases.map((c) => ({
        teammate: "arjun" as const,
        title: `Chase email to ${c.company.name} — check and send`,
        detail: null,
        href: "/collections",
        at: c.createdAt.toISOString(),
        decide: { kind: "chase" as const, id: c.id },
      })),
    ],
    count: chaseCount + replyCount,
  };
}

/** Priya: questions she passed to HR, for whoever answers them ("Manage people records"). */
async function priya(userId: string): Promise<Counted> {
  if (!(await can(userId, "hr.manage"))) return none;
  const [rows, count] = await Promise.all([
    quietly(
      () =>
        db.hrDeskQuestion.findMany({
          where: { status: "WITH_HR" },
          orderBy: { handedAt: "asc" },
          take: PER_SOURCE,
          select: { handedAt: true, createdAt: true, asker: { select: { name: true } } },
        }),
      [],
    ),
    quietly(() => db.hrDeskQuestion.count({ where: { status: "WITH_HR" } }), 0),
  ]);
  return {
    items: rows.map((q) => ({
      teammate: "priya" as const,
      title: `${q.asker?.name ?? "Somebody"} asked HR a question`,
      detail: "Passed on by Priya",
      href: "/people/hr-desk",
      at: (q.handedAt ?? q.createdAt).toISOString(),
    })),
    count,
  };
}

/** Kabir: open chats given to this person whose last word is the customer's — they're waiting on a reply. */
async function kabir(userId: string): Promise<Counted> {
  const rows = await quietly(
    () =>
      db.conversation.findMany({
        where: { status: "OPEN", assignedToUserId: userId, botActive: false },
        orderBy: { lastMessageAt: "asc" },
        take: 50,
        select: {
          id: true,
          customerName: true,
          customerCompany: true,
          lastMessageAt: true,
          messages: { where: { author: { in: ["CUSTOMER", "AGENT", "BOT"] } }, orderBy: { createdAt: "desc" }, take: 1, select: { author: true } },
        },
      }),
    [],
  );
  const waiting = rows.filter((c) => c.messages[0]?.author === "CUSTOMER");
  return {
    items: waiting.slice(0, PER_SOURCE).map((c) => ({
      teammate: "kabir" as const,
      title: `${c.customerName ?? "A visitor"} is waiting for your reply`,
      detail: c.customerCompany,
      href: `/inbox?c=${c.id}`,
      at: c.lastMessageAt.toISOString(),
    })),
    count: waiting.length,
  };
}

/** Everything waiting for this person, oldest first — at most `take` shown, every one counted. */
export async function waitingForYou(userId: string, take = 12): Promise<WaitingForYou> {
  const parts = await Promise.all([tara(userId), arjun(userId), priya(userId), kabir(userId)].map((p) => p.catch((err) => (console.error("[waiting]", err instanceof Error ? err.message : err), none))));
  const [t, a, p, k] = parts as [Counted, Counted, Counted, Counted];
  const items = [...t.items, ...a.items, ...p.items, ...k.items].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  const byTeammate: Partial<Record<TeammateKey, number>> = {};
  if (t.count) byTeammate.tara = t.count;
  if (a.count) byTeammate.arjun = a.count;
  if (p.count) byTeammate.priya = p.count;
  if (k.count) byTeammate.kabir = k.count;
  return { items: items.slice(0, take), total: t.count + a.count + p.count + k.count, byTeammate };
}
