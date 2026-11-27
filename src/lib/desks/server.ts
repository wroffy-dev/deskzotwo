import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { officeHours } from "@/lib/hr/office-hours";
import type { OfficeHours } from "@/lib/hr/office-hours-rules";
import { officeMinutesBetween } from "@/lib/leads/response";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import {
  addOfficeMinutes,
  APPROVALS,
  BODY_MAX,
  CLOSED,
  COMMENT_MAX,
  deskLabel,
  dueState,
  formatRequestId,
  HELD,
  isClosed,
  isDeskStatus,
  isHeld,
  isLevel,
  PAUSED,
  readTimes,
  REOPEN_DAYS,
  REQUESTS_PER_DAY,
  requestPath,
  ROUTINGS,
  spanMinutes,
  STEP_MAX,
  STEPS_MAX,
  TITLE_MAX,
  type Level,
  type Routing,
  type Times,
  type TypeApproval,
} from "./rules";

/**
 * The internal help desk (owner, 25 Nov 2026 — the rules are ./rules.ts): employees ask a desk inside the company — IT,
 * Admin, Accounts — and its people work the requests.
 *
 *   · **Who sees a request:** whoever asked, the desk's people (its department's) and the super admin. Nobody else, no
 *     admin, no manager, not the old desk once it has moved — so it is in no search, report, activity log or audit entry:
 *     the request's own events are its trail. Somebody who asked their own desk is only the one who asked: they don't see
 *     its notes or work it.
 *   · **Approval** (phase 2): whoever is asked to approve one sees what was asked, never the conversation. A kind that is
 *     approved first isn't the desk's to see until it is — nor, rejected, ever (`HELD`). The super admin may decide any.
 *   · **Apart from customers' tickets:** a ticket is about a customer and follows their account.
 *   · **The clock** is office time and stops while it waits for whoever asked or is on hold (`stopClock`, `startClock`).
 *   · Every write locks the request's row first, so two people picking it up at once is one of them picking it up.
 */

export class DeskRefusal extends Error {}
const gone = () => new DeskRefusal("That request isn't there.");

type Tx = Prisma.TransactionClient;
export type DeskFile = { fileName: string; mimeType: string; size: number; data: Uint8Array<ArrayBuffer> };

// ─── Who is asking ───────────────────────────────────────────────────────────────────────────────

export type Viewer = { userId: string; name: string; departmentId: string | null; superAdmin: boolean };

/** The person, if they're one of ours: somebody signed in to support us, or who has left, has no help desk. */
export async function viewerOf(userId: string): Promise<Viewer | null> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { name: true, departmentId: true, active: true, kind: true } });
  if (!u?.active || u.kind !== "MEMBER") return null;
  return { userId, name: u.name, departmentId: u.departmentId, superAdmin: await actingAsSuperAdmin(userId) };
}

export type Side = "requester" | "desk" | "approver";

/** Which side of a request somebody is on; null: neither, and it isn't there for them — unless they approve it (`findRequest`). */
export function sideOf(v: Viewer, r: { requesterId: string; status: string; desk: { departmentId: string | null } }): Side | null {
  if (r.requesterId === v.userId) return "requester";
  if (isHeld(r.status)) return null;
  if (v.superAdmin) return "desk";
  return r.desk.departmentId !== null && r.desk.departmentId === v.departmentId ? "desk" : null;
}

/** Whether they approve it, or did — and the super admin, of one the desk doesn't see. */
async function approves(v: Viewer, r: { id: string; status: string }): Promise<boolean> {
  if (v.superAdmin && isHeld(r.status)) return true;
  return (await db.deskApproval.count({ where: { requestId: r.id, approverId: v.userId, status: { not: "WITHDRAWN" } } })) > 0;
}

const worksAt = (v: Viewer, desk: { departmentId: string | null }) => v.superAdmin || (desk.departmentId !== null && desk.departmentId === v.departmentId);

/** A desk's people, by name: its department's, still here. */
async function peopleOf(departmentId: string | null, client: Tx | typeof db = db): Promise<{ id: string; name: string }[]> {
  if (!departmentId) return [];
  return client.user.findMany({ where: { departmentId, active: true, kind: "MEMBER" }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true } });
}

// ─── Desks ───────────────────────────────────────────────────────────────────────────────────────

export type LiveDesk = { id: string; seq: number; name: string; description: string | null; times: Times; people: string[]; types: { id: string; name: string; asksAsset: boolean; approval: TypeApproval }[] };

/** A kind's approval as kept; anything else, none. */
const readApproval = (v: string): TypeApproval => ((APPROVALS as readonly string[]).includes(v) ? (v as TypeApproval) : "NONE");

/** The desks an employee can ask: switched on, with somebody there to answer. */
export async function liveDesks(): Promise<LiveDesk[]> {
  const rows = await db.desk.findMany({
    where: { active: true, department: { members: { some: { active: true, kind: "MEMBER" } } } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, seq: true, name: true, description: true, times: true, departmentId: true, types: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, asksAsset: true, approval: true } } },
  });
  return Promise.all(rows.map(async (d) => ({ id: d.id, seq: d.seq, name: d.name, description: d.description, times: readTimes(d.times), people: (await peopleOf(d.departmentId)).map((p) => p.name), types: d.types.map((t) => ({ ...t, approval: readApproval(t.approval) })) })));
}

// ─── The clock ───────────────────────────────────────────────────────────────────────────────────

type Office = { clock: Clock; hours: OfficeHours | null; holiday: (day: string) => boolean };
async function office(now: Date): Promise<Office> {
  const [clock, hours] = await Promise.all([workspaceClock(), officeHours()]);
  const days = new Set((await db.holiday.findMany({ where: { optional: false, date: { gte: new Date(now.getTime() - 120 * 86_400_000) } }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)));
  return { clock, hours, holiday: (d) => days.has(d) };
}
const after = (o: Office, from: Date, minutes: number) => addOfficeMinutes(from, minutes, o.clock, o.hours, o.holiday);

function dues(o: Office, times: Times, level: Level, from: Date) {
  return { replyDueAt: after(o, from, spanMinutes(times[level].reply, o.hours)), fixDueAt: after(o, from, spanMinutes(times[level].fix, o.hours)) };
}

type Clocked = { status: string; pausedAt: Date | null; replyDueAt: Date | null; fixDueAt: Date | null; firstRepliedAt: Date | null };
const stopClock = (r: Clocked, now: Date) => (r.pausedAt ? {} : { pausedAt: now });
/** Going again: what's still owed moves on by the office time it was stopped. */
function startClock(o: Office, r: Clocked, now: Date): { pausedAt: null; replyDueAt?: Date; fixDueAt?: Date } {
  if (!r.pausedAt) return { pausedAt: null };
  const stopped = officeMinutesBetween(r.pausedAt, now, o.clock, o.hours, o.holiday);
  return {
    pausedAt: null,
    ...(r.replyDueAt && !r.firstRepliedAt ? { replyDueAt: after(o, r.replyDueAt, stopped) } : {}),
    ...(r.fixDueAt ? { fixDueAt: after(o, r.fixDueAt, stopped) } : {}),
  };
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** The request and which side they're on — or nothing at all, whether it isn't there or isn't theirs. */
export async function findRequest(v: Viewer, ref: { seq: number } | { id: string }): Promise<{ id: string; seq: number; side: Side } | null> {
  const r = await db.deskRequest.findUnique({ where: ref, select: { id: true, seq: true, requesterId: true, status: true, desk: { select: { departmentId: true } } } });
  const side = r ? (sideOf(v, r) ?? ((await approves(v, r)) ? "approver" : null)) : null;
  return r && side ? { id: r.id, seq: r.seq, side } : null;
}

const rowSelect = {
  id: true,
  seq: true,
  title: true,
  level: true,
  status: true,
  createdAt: true,
  lastActivityAt: true,
  replyDueAt: true,
  fixDueAt: true,
  firstRepliedAt: true,
  desk: { select: { seq: true, name: true } },
  type: { select: { name: true } },
  assignedTo: { select: { id: true, name: true } },
  requester: { select: { id: true, name: true, department: { select: { name: true } } } },
} satisfies Prisma.DeskRequestSelect;
export type RequestRow = Prisma.DeskRequestGetPayload<{ select: typeof rowSelect }>;

/** What this person asked for, newest first. */
export async function myRequests(v: Viewer, all: boolean): Promise<RequestRow[]> {
  return db.deskRequest.findMany({ where: { requesterId: v.userId, ...(all ? {} : { status: { notIn: CLOSED } }) }, orderBy: { lastActivityAt: "desc" }, take: 200, select: rowSelect });
}

export const QUEUE_TABS = ["open", "free", "mine", "late", "resolved"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const QUEUE_LABELS: Record<QueueTab, string> = { open: "All open", free: "Not picked up", mine: "Mine", late: "Overdue", resolved: "Resolved" };

function tabWhere(v: Viewer, tab: QueueTab, now: Date): Prisma.DeskRequestWhereInput {
  const open: Prisma.DeskRequestWhereInput = { status: { notIn: CLOSED } };
  switch (tab) {
    case "resolved":
      return { status: "RESOLVED" };
    case "free":
      return { ...open, assignedToId: null };
    case "mine":
      return { ...open, assignedToId: v.userId };
    case "late":
      return { status: { in: ["OPEN", "IN_PROGRESS"] }, OR: [{ firstRepliedAt: null, replyDueAt: { lte: now } }, { fixDueAt: { lte: now } }] };
    default:
      return open;
  }
}

export type Queue = { desk: { id: string; seq: number; name: string; active: boolean }; people: { id: string; name: string }[]; counts: Record<QueueTab, number>; rows: RequestRow[] };

/**
 * A desk's list, for its people — null to anybody else. A person's own request to their own desk isn't in it: they are
 * the one who asked.
 */
export async function deskQueue(v: Viewer, seq: number, tab: QueueTab, now = new Date()): Promise<Queue | null> {
  const desk = await db.desk.findUnique({ where: { seq }, select: { id: true, seq: true, name: true, active: true, departmentId: true } });
  if (!desk || !worksAt(v, desk)) return null;
  const theirs = { deskId: desk.id, requesterId: { not: v.userId }, NOT: { status: { in: HELD } } };
  const [people, counted, rows] = await Promise.all([
    peopleOf(desk.departmentId),
    Promise.all(QUEUE_TABS.map((t) => db.deskRequest.count({ where: { AND: [theirs, tabWhere(v, t, now)] } }))),
    db.deskRequest.findMany({ where: { AND: [theirs, tabWhere(v, tab, now)] }, orderBy: tab === "resolved" ? { resolvedAt: "desc" } : [{ fixDueAt: { sort: "asc", nulls: "last" } }, { seq: "asc" }], take: 300, select: rowSelect }),
  ]);
  // What's late or due soonest first, by what it owes next.
  const owed = (r: RequestRow) => (PAUSED.has(r.status) ? Infinity : Math.min(!r.firstRepliedAt && r.replyDueAt ? r.replyDueAt.getTime() : Infinity, r.fixDueAt?.getTime() ?? Infinity));
  if (tab !== "resolved") rows.sort((a, b) => owed(a) - owed(b) || a.seq - b.seq);
  return { desk: { id: desk.id, seq: desk.seq, name: desk.name, active: desk.active }, people, counts: Object.fromEntries(QUEUE_TABS.map((t, i) => [t, counted[i]!])) as Record<QueueTab, number>, rows };
}

export type RequestDetail = {
  id: string;
  seq: number;
  side: Side;
  title: string;
  details: string;
  level: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  replyDueAt: Date | null;
  fixDueAt: Date | null;
  firstRepliedAt: Date | null;
  desk: { id: string; seq: number; name: string };
  type: string | null;
  requester: { id: string; name: string; department: string | null };
  raisedBy: string | null;
  assignedTo: { id: string; name: string } | null;
  asset: { id: string; assetTag: string; name: string; status: string; warrantyEndsOn: Date | null; withThem: boolean } | null;
  /** The desk's side: what else it was asked about the same asset. */
  earlier: { seq: number; title: string; createdAt: Date; status: string }[];
  /** A reason and the desk's own approver's comment are the desk's and the approver's; whoever asked sees a FIRST one's. */
  approvals: { id: string; stage: string; status: string; approver: string; askedBy: string | null; reason: string; comment: string | null; decidedBy: string | null; decidedAt: Date | null }[];
  /** This reader may approve or reject it now — and `inPlace`: for whoever was asked, as the super admin. */
  mayDecide: boolean;
  inPlace: boolean;
  /** The desk's side only. */
  steps: { id: string; title: string; assignee: { id: string; name: string } | null; doneAt: Date | null; doneBy: string | null }[];
  files: { id: string; fileName: string; size: number; mimeType: string }[];
  messages: { id: string; kind: string; body: string; createdAt: Date; author: { id: string; name: string } | null; files: { id: string; fileName: string; size: number; mimeType: string }[] }[];
  /** The desk's side only: who can have it, and the desks it can move to. */
  people: { id: string; name: string }[];
  otherDesks: { id: string; name: string }[];
  canReopen: boolean;
};

/** A request as its reader sees it: whoever asked never gets the desk's notes, or their files. */
export async function requestDetail(v: Viewer, id: string, now = new Date()): Promise<RequestDetail | null> {
  const found = await findRequest(v, { id });
  if (!found) return null;
  const desk = found.side === "desk";
  const approver = found.side === "approver";
  const file = { id: true, fileName: true, size: true, mimeType: true } as const;
  const r = await db.deskRequest.findUniqueOrThrow({
    where: { id },
    select: {
      id: true, seq: true, title: true, details: true, level: true, status: true, createdAt: true, resolvedAt: true, replyDueAt: true, fixDueAt: true, firstRepliedAt: true,
      desk: { select: { id: true, seq: true, name: true, departmentId: true } },
      type: { select: { name: true } },
      requester: { select: { id: true, name: true, department: { select: { name: true } } } },
      raisedBy: { select: { name: true } },
      assignedTo: { select: { id: true, name: true } },
      asset: { select: { id: true, assetTag: true, name: true, status: true, warrantyEndsOn: true, custodianUserId: true } },
      approvals: { where: { status: { not: "WITHDRAWN" }, ...(desk ? {} : approver && !v.superAdmin ? { approverId: v.userId } : {}) }, orderBy: { createdAt: "asc" }, select: { id: true, stage: true, status: true, approverId: true, askedById: true, approver: { select: { name: true } }, askedBy: { select: { name: true } }, reason: true, comment: true, decidedBy: { select: { name: true } }, decidedAt: true } },
      steps: { where: desk ? {} : { id: "" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, title: true, assignee: { select: { id: true, name: true } }, doneAt: true, doneBy: { select: { name: true } } } },
      files: { where: { messageId: null, ...(desk ? {} : { deskOnly: false }) }, orderBy: { createdAt: "asc" }, select: file },
      // Whoever approves it sees what was asked, never what was said.
      messages: { where: desk ? {} : approver ? { id: "" } : { kind: { not: "NOTE" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, kind: true, body: true, createdAt: true, author: { select: { id: true, name: true } }, files: { select: file } } },
    },
  });
  const [people, desks, earlier] = desk
    ? await Promise.all([
        peopleOf(r.desk.departmentId),
        liveDesks(),
        // This desk's alone: another desk's requests about it are that desk's.
        r.asset ? db.deskRequest.findMany({ where: { assetId: r.asset.id, deskId: r.desk.id, id: { not: id }, requesterId: { not: v.userId }, NOT: { status: { in: HELD } } }, orderBy: { createdAt: "desc" }, take: 10, select: { seq: true, title: true, createdAt: true, status: true } }) : [],
      ])
    : [[], [], []];
  const pending = r.approvals.find((a) => a.status === "PENDING");
  return {
    ...r,
    side: found.side,
    desk: { id: r.desk.id, seq: r.desk.seq, name: r.desk.name },
    type: r.type?.name ?? null,
    requester: { id: r.requester.id, name: r.requester.name, department: r.requester.department?.name ?? null },
    raisedBy: r.raisedBy?.name ?? null,
    asset: r.asset ? { id: r.asset.id, assetTag: r.asset.assetTag, name: r.asset.name, status: r.asset.status, warrantyEndsOn: r.asset.warrantyEndsOn, withThem: r.asset.custodianUserId === r.requester.id } : null,
    people: people.filter((p) => p.id !== r.requester.id),
    otherDesks: desks.filter((d) => d.id !== r.desk.id).map((d) => ({ id: d.id, name: d.name })),
    canReopen: mayReopen(r, now),
    earlier,
    approvals: r.approvals.map((a) => ({
      id: a.id,
      stage: a.stage,
      status: a.status,
      approver: a.approver.name,
      askedBy: a.askedBy?.name ?? null,
      reason: found.side === "requester" ? "" : a.reason,
      comment: found.side === "requester" && a.stage === "DESK" ? null : a.comment,
      decidedBy: a.decidedBy?.name ?? null,
      decidedAt: a.decidedAt,
    })),
    mayDecide: !!pending && found.side !== "requester" && mayAnswer(v, pending),
    inPlace: !!pending && pending.approverId !== v.userId,
    steps: r.steps.map((s) => ({ ...s, doneBy: s.doneBy?.name ?? null })),
  };
}

const mayReopen = (r: { status: string; resolvedAt: Date | null }, now: Date) => r.status === "RESOLVED" && !!r.resolvedAt && now.getTime() - r.resolvedAt.getTime() < REOPEN_DAYS * 86_400_000;

/** A file on a request, if they may see it. */
export async function requestFile(v: Viewer, fileId: string) {
  const f = await db.deskRequestFile.findUnique({ where: { id: fileId }, select: { fileName: true, mimeType: true, data: true, deskOnly: true, messageId: true, message: { select: { kind: true } }, request: { select: { id: true, status: true, requesterId: true, desk: { select: { departmentId: true } } } } } });
  const side = f ? (sideOf(v, f.request) ?? ((await approves(v, f.request)) ? "approver" : null)) : null;
  if (!f || !side || (side !== "desk" && (f.deskOnly || f.message?.kind === "NOTE")) || (side === "approver" && f.messageId)) return null;
  return { fileName: f.fileName, mimeType: f.mimeType, data: f.data };
}

/** Their own company assets, to say which a request is about — where the workspace keeps an asset register. */
export async function assetsFor(userId: string): Promise<{ id: string; label: string }[]> {
  if (!(await moduleAvailableForTenant("it_assets"))) return [];
  const rows = await db.asset.findMany({ where: { custodianUserId: userId, status: { notIn: ["RETIRED", "LOST"] } }, orderBy: { assetTag: "asc" }, take: 100, select: { id: true, assetTag: true, name: true } });
  return rows.map((a) => ({ id: a.id, label: `${a.assetTag}, ${a.name}` }));
}

// ─── Raising ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Who approves a request first: their manager, or — with none here — the super admin. Nobody when that's who is asking:
 * there's no one above to ask.
 */
export async function approverFor(requesterId: string): Promise<{ id: string; name: string } | null> {
  const u = await db.user.findUnique({ where: { id: requesterId }, select: { manager: { select: { id: true, name: true, active: true, kind: true } } } });
  const m = u?.manager;
  if (m && m.active && m.kind === "MEMBER" && m.id !== requesterId) return { id: m.id, name: m.name };
  return db.user.findFirst({ where: { isSuperAdmin: true, active: true, kind: "MEMBER", id: { not: requesterId } }, select: { id: true, name: true } });
}

/** Who a new request goes to by the desk's rule; null: the whole desk. Never whoever asked. Locks the desk, for its turn. */
async function route(tx: Tx, deskId: string, requesterId: string): Promise<string | null> {
  await tx.$queryRaw`SELECT "id" FROM "desks" WHERE "id" = ${deskId} FOR UPDATE`;
  const desk = await tx.desk.findUniqueOrThrow({ where: { id: deskId }, select: { routing: true, personId: true, turnLastId: true, departmentId: true } });
  const people = (await peopleOf(desk.departmentId, tx)).filter((p) => p.id !== requesterId);
  if (desk.routing === "PERSON") return people.some((p) => p.id === desk.personId) ? desk.personId : null;
  if (desk.routing !== "TURN" || people.length === 0) return null;
  const at = people.findIndex((p) => p.id === desk.turnLastId);
  const next = people[(at + 1) % people.length]!;
  await tx.desk.update({ where: { id: deskId }, data: { turnLastId: next.id }, select: { id: true } });
  return next.id;
}

/** The new request told to whoever it went to, or to the whole desk. */
async function tellNew(requestId: string) {
  const r = await db.deskRequest.findUnique({ where: { id: requestId }, select: { seq: true, title: true, requesterId: true, assignedToId: true, requester: { select: { name: true } }, desk: { select: { name: true, departmentId: true } } } });
  if (!r) return;
  const to = r.assignedToId ? [r.assignedToId] : (await peopleOf(r.desk.departmentId)).map((p) => p.id).filter((id) => id !== r.requesterId);
  for (const userId of to) {
    await notifyUser({ userId, type: "DESK_REQUEST_NEW", title: `${formatRequestId(r.seq)} for ${r.assignedToId ? "you" : `the ${deskLabel(r.desk.name)}`}`, message: `${r.requester.name}: ${r.title}`, link: requestPath(r.seq) });
  }
}

export type RaiseInput = { deskId: string; typeId: string | null; title: string; details: string; level: string; assetId: string | null; forUserId?: string | null; files?: DeskFile[] };

const line = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Whether they may raise a request to this desk for that colleague: one of its people, for somebody who works here. */
export async function mayRaiseFor(v: Viewer, deskId: string, userId: string): Promise<boolean> {
  const desk = await db.desk.findUnique({ where: { id: deskId }, select: { departmentId: true, active: true } });
  return !!desk?.active && worksAt(v, desk) && (await viewerOf(userId)) !== null;
}

/** What's wrong with a request as typed; null when it can be made. Asked before its files are kept. */
export async function raiseProblem(v: Viewer, input: RaiseInput, now = new Date()): Promise<string | null> {
  if (line(input.title, TITLE_MAX).length < 3) return "Say what it's about in one line.";
  if (input.details.length > BODY_MAX) return `That's more than ${BODY_MAX.toLocaleString("en-IN")} characters — attach it as a file.`;
  if (!isLevel(input.level)) return "Say how much it's holding you up.";
  const desk = (await liveDesks()).find((d) => d.id === input.deskId);
  if (!desk) return "That desk isn't taking requests.";
  if (input.typeId ? !desk.types.some((t) => t.id === input.typeId) : desk.types.length > 0) return "Choose what it's about.";
  if (input.forUserId && input.forUserId !== v.userId && !(await mayRaiseFor(v, desk.id, input.forUserId))) return "Only the desk's own people raise a request for a colleague, who works here.";
  const requester = input.forUserId || v.userId;
  if (input.assetId && !(await assetsFor(requester)).some((a) => a.id === input.assetId)) return "That asset isn't on their name.";
  const midnight = (await workspaceClock()).startOfDay((await workspaceClock()).today(now)) ?? new Date(now.getTime() - 86_400_000);
  if ((await db.deskRequest.count({ where: { OR: [{ raisedById: v.userId }, { requesterId: v.userId, raisedById: null }], createdAt: { gte: midnight } } })) >= REQUESTS_PER_DAY) return `That's ${REQUESTS_PER_DAY} requests today — add to one you've made, or ask the desk directly.`;
  return null;
}

export async function raiseRequest(v: Viewer, input: RaiseInput, now = new Date()): Promise<{ id: string; seq: number }> {
  const problem = await raiseProblem(v, input, now);
  if (problem) throw new DeskRefusal(problem);
  const requesterId = input.forUserId || v.userId;
  const [o, desk, type] = await Promise.all([
    office(now),
    db.desk.findUniqueOrThrow({ where: { id: input.deskId }, select: { times: true } }),
    input.typeId ? db.deskRequestType.findUnique({ where: { id: input.typeId }, select: { approval: true } }) : null,
  ]);
  const approver = readApproval(type?.approval ?? "") === "MANAGER" ? await approverFor(requesterId) : null;
  // Raised by whoever would approve it: that's their yes.
  const held = approver && approver.id !== v.userId ? approver : null;
  const made = await db.$transaction(async (tx) => {
    // Held for approval, it goes to nobody and its time hasn't begun.
    const assignedToId = held ? null : await route(tx, input.deskId, requesterId);
    const r = await tx.deskRequest.create({
      data: {
        deskId: input.deskId,
        typeId: input.typeId || null,
        requesterId,
        raisedById: requesterId === v.userId ? null : v.userId,
        title: line(input.title, TITLE_MAX),
        details: input.details.trim().slice(0, BODY_MAX),
        level: input.level,
        assetId: input.assetId || null,
        assignedToId,
        ...(held ? { status: "APPROVAL" } : dues(o, readTimes(desk.times), input.level as Level, now)),
        createdAt: now,
        lastActivityAt: now,
      },
      select: { id: true, seq: true },
    });
    for (const f of input.files ?? []) await tx.deskRequestFile.create({ data: { requestId: r.id, uploadedById: v.userId, ...f }, select: { id: true } });
    if (held) await tx.deskApproval.create({ data: { requestId: r.id, stage: "FIRST", approverId: held.id, createdAt: now }, select: { id: true } });
    return r;
  });
  if (held) {
    const who = (await db.user.findUnique({ where: { id: requesterId }, select: { name: true } }))?.name ?? "Somebody";
    await notifyUser({ userId: held.id, type: "DESK_REQUEST_APPROVAL", title: `${formatRequestId(made.seq)} waits for your approval`, message: `${who}: ${line(input.title, TITLE_MAX)}`, link: requestPath(made.seq) });
  } else await tellNew(made.id);
  if (requesterId !== v.userId) await notifyUser({ userId: requesterId, type: "DESK_REQUEST_UPDATE", title: `${v.name} raised ${formatRequestId(made.seq)} for you`, message: line(input.title, TITLE_MAX), link: requestPath(made.seq) });
  return made;
}

// ─── Working it ──────────────────────────────────────────────────────────────────────────────────

const lockedSelect = {
  id: true, seq: true, title: true, deskId: true, requesterId: true, assignedToId: true, level: true, status: true, pausedAt: true, replyDueAt: true, fixDueAt: true, firstRepliedAt: true, resolvedAt: true,
  desk: { select: { id: true, seq: true, name: true, departmentId: true, times: true } },
} satisfies Prisma.DeskRequestSelect;
type Locked = Prisma.DeskRequestGetPayload<{ select: typeof lockedSelect }>;

/** The request held, and the side they're on as it is now — moved or taken meanwhile is seen. */
async function holding<T>(v: Viewer, id: string, side: Side, work: (tx: Tx, r: Locked) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "desk_requests" WHERE "id" = ${id} FOR UPDATE`;
    const r = await tx.deskRequest.findUnique({ where: { id }, select: lockedSelect });
    if (!r || sideOf(v, r) !== side) throw gone();
    return work(tx, r);
  });
}

const event = (tx: Tx, requestId: string, authorId: string | null, body: string, now: Date) => tx.deskRequestMessage.create({ data: { requestId, authorId, kind: "EVENT", body, createdAt: now }, select: { id: true } });
const change = (tx: Tx, id: string, data: Prisma.DeskRequestUncheckedUpdateInput, now: Date) => tx.deskRequest.update({ where: { id }, data: { ...data, lastActivityAt: now }, select: { id: true } });

/** Told to the desk's side: whoever has it, else the whole desk. */
async function tellDesk(r: Locked, by: Viewer, title: string, message: string) {
  const to = r.assignedToId ? [r.assignedToId] : (await peopleOf(r.desk.departmentId)).map((p) => p.id);
  for (const userId of to) if (userId !== by.userId && userId !== r.requesterId) await notifyUser({ userId, type: "DESK_REQUEST_UPDATE", title, message, link: requestPath(r.seq) });
}
async function tellRequester(r: Locked, by: Viewer, title: string, message: string) {
  if (r.requesterId !== by.userId) await notifyUser({ userId: r.requesterId, type: "DESK_REQUEST_UPDATE", title, message, link: requestPath(r.seq) });
}
const short = (s: string) => line(s, 300);

/** Mine, then: for one nobody has. */
export async function pickUp(v: Viewer, id: string, now = new Date()): Promise<void> {
  const o = await office(now);
  const r = await holding(v, id, "desk", async (tx, r) => {
    if (isClosed(r.status)) throw new DeskRefusal("It's resolved already.");
    if (r.assignedToId === v.userId) return null;
    if (r.assignedToId) throw new DeskRefusal("Somebody has picked it up already.");
    await change(tx, id, { assignedToId: v.userId, ...(r.status === "OPEN" ? { status: "IN_PROGRESS", ...startClock(o, r, now) } : {}) }, now);
    await event(tx, id, v.userId, `${v.name} picked it up`, now);
    return r;
  });
  if (r) await tellRequester(r, v, `${v.name} picked up ${formatRequestId(r.seq)}`, r.title);
}

/** Given to one of the desk's people, or back to the desk. */
export async function assign(v: Viewer, id: string, toId: string | null, now = new Date()): Promise<void> {
  const r = await holding(v, id, "desk", async (tx, r) => {
    if (toId === r.assignedToId) return null;
    const to = toId ? ((await peopleOf(r.desk.departmentId, tx)).find((p) => p.id === toId) ?? (v.superAdmin && toId === v.userId ? { id: v.userId, name: v.name } : undefined)) : null;
    if (toId && (!to || to.id === r.requesterId)) throw new DeskRefusal("Choose one of the desk's people.");
    await change(tx, id, { assignedToId: toId }, now);
    await event(tx, id, v.userId, to ? (to.id === v.userId ? `${v.name} took it` : `${v.name} gave it to ${to.name}`) : `${v.name} put it back with the desk`, now);
    return { ...r, assignedToId: toId };
  });
  if (!r) return;
  if (r.assignedToId && r.assignedToId !== v.userId) await notifyUser({ userId: r.assignedToId, type: "DESK_REQUEST_NEW", title: `${formatRequestId(r.seq)} for you`, message: r.title, link: requestPath(r.seq) });
}

/** Where it stands, by the desk. Resolving counts as the first reply, when there was none. */
export async function setStatus(v: Viewer, id: string, status: string, now = new Date()): Promise<void> {
  if (!isDeskStatus(status)) throw new DeskRefusal("Choose where it stands.");
  const o = await office(now);
  const r = await holding(v, id, "desk", async (tx, r) => {
    if (r.status === status) return null;
    const desk = r.desk;
    // Going on without the answer.
    if (r.status === "ASKED") await withdraw(tx, id, now);
    await change(
      tx,
      id,
      {
        status,
        ...(r.assignedToId ? {} : { assignedToId: v.userId }),
        ...(status === "RESOLVED"
          ? { resolvedAt: now, pausedAt: null, ...(r.firstRepliedAt ? {} : { firstRepliedAt: now }) }
          : PAUSED.has(status)
            ? { resolvedAt: null, ...stopClock(r, now) }
            : // Opened again gets its time afresh; off hold, what was left of it.
              { resolvedAt: null, ...(r.status === "RESOLVED" ? reopened(o, readTimes(desk.times), r, now) : startClock(o, r, now)) }),
      },
      now,
    );
    await event(tx, id, v.userId, `${v.name} ${EVENT_WORDS[status]}`, now);
    return r;
  });
  if (r && status !== "IN_PROGRESS") await tellRequester(r, v, `${formatRequestId(r.seq)} is ${status === "RESOLVED" ? "resolved" : status === "WAITING" ? "waiting for you" : "on hold"}`, r.title);
}
const EVENT_WORDS: Record<string, string> = { IN_PROGRESS: "is working on it", WAITING: "is waiting for an answer", ON_HOLD: "put it on hold", RESOLVED: "resolved it" };

function reopened(o: Office, times: Times, r: Locked, now: Date) {
  return { pausedAt: null, fixDueAt: dues(o, times, isLevel(r.level) ? r.level : "SLOW", now).fixDueAt, fixLateToldAt: null };
}

const withdraw = (tx: Tx, requestId: string, now: Date) => tx.deskApproval.updateMany({ where: { requestId, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: now } });

async function say(tx: Tx, r: Locked, v: Viewer, kind: "REPLY" | "NOTE", body: string, files: DeskFile[], now: Date) {
  const m = await tx.deskRequestMessage.create({ data: { requestId: r.id, authorId: v.userId, kind, body, createdAt: now }, select: { id: true } });
  for (const f of files) await tx.deskRequestFile.create({ data: { requestId: r.id, messageId: m.id, uploadedById: v.userId, deskOnly: kind === "NOTE", ...f }, select: { id: true } });
}

function bodyOrRefuse(text: string, files: DeskFile[]): string {
  const body = text.trim();
  if (!body && files.length === 0) throw new DeskRefusal("Write something first.");
  if (body.length > BODY_MAX) throw new DeskRefusal(`That's more than ${BODY_MAX.toLocaleString("en-IN")} characters — attach it as a file.`);
  return body;
}

/** A reply from the desk. One nobody has is picked up by it; with `resolve`, it's the last word. */
export async function replyFromDesk(v: Viewer, id: string, text: string, files: DeskFile[] = [], resolve = false, now = new Date()): Promise<void> {
  const body = bodyOrRefuse(text, files);
  const o = await office(now);
  const r = await holding(v, id, "desk", async (tx, r) => {
    await say(tx, r, v, "REPLY", body, files, now);
    if (resolve) {
      await withdraw(tx, id, now);
      await event(tx, id, v.userId, `${v.name} ${EVENT_WORDS.RESOLVED}`, now);
    }
    await change(
      tx,
      id,
      {
        ...(r.firstRepliedAt ? {} : { firstRepliedAt: now }),
        ...(r.assignedToId ? {} : { assignedToId: v.userId }),
        // A last word after it was resolved leaves it resolved.
        ...(resolve ? { status: "RESOLVED", resolvedAt: now, pausedAt: null } : r.status === "OPEN" ? { status: "IN_PROGRESS", ...startClock(o, r, now) } : {}),
      },
      now,
    );
    return r;
  });
  await tellRequester(r, v, `${v.name} ${resolve ? "resolved" : "replied on"} ${formatRequestId(r.seq)}`, short(body) || "A file is attached.");
}

/** A note only the desk sees. */
export async function addNote(v: Viewer, id: string, text: string, files: DeskFile[] = [], now = new Date()): Promise<void> {
  const body = bodyOrRefuse(text, files);
  const r = await holding(v, id, "desk", async (tx, r) => {
    await say(tx, r, v, "NOTE", body, files, now);
    await change(tx, id, {}, now);
    return r;
  });
  if (r.assignedToId) await tellDesk(r, v, `${v.name} left a note on ${formatRequestId(r.seq)}`, short(body) || "A file is attached.");
}

/** A reply from whoever asked: it starts again what waited for them, and opens again what was resolved lately. */
export async function replyFromRequester(v: Viewer, id: string, text: string, files: DeskFile[] = [], now = new Date()): Promise<void> {
  const body = bodyOrRefuse(text, files);
  const o = await office(now);
  const r = await holding(v, id, "requester", async (tx, r) => {
    if (r.status === "APPROVAL") throw new DeskRefusal("It's waiting for approval — the desk sees it once it's approved.");
    if (r.status === "REJECTED") throw new DeskRefusal("It wasn't approved. Make a new request if something has changed.");
    if (r.status === "RESOLVED" && !mayReopen(r, now)) throw new DeskRefusal("It was resolved a while ago — make a new request, and say it's about this one.");
    await say(tx, r, v, "REPLY", body, files, now);
    const working = r.assignedToId ? "IN_PROGRESS" : "OPEN";
    if (r.status === "RESOLVED") await event(tx, id, v.userId, `${v.name} opened it again`, now);
    await change(tx, id, r.status === "RESOLVED" ? { status: working, resolvedAt: null, ...reopened(o, readTimes(r.desk.times), r, now) } : r.status === "WAITING" ? { status: working, ...startClock(o, r, now) } : {}, now);
    return r;
  });
  await tellDesk(r, v, `${v.name} ${r.status === "RESOLVED" ? "opened again" : "replied on"} ${formatRequestId(r.seq)}`, short(body) || "A file is attached.");
}

/** Whoever asked says it's sorted. */
export async function closeOwn(v: Viewer, id: string, now = new Date()): Promise<void> {
  const r = await holding(v, id, "requester", async (tx, r) => {
    if (isClosed(r.status)) return null;
    await withdraw(tx, id, now);
    // Taken back before it was approved, it's still not the desk's to see.
    await change(tx, id, { status: r.status === "APPROVAL" ? "REJECTED" : "RESOLVED", resolvedAt: now, pausedAt: null }, now);
    await event(tx, id, v.userId, r.status === "APPROVAL" ? `${v.name} took it back` : `${v.name} said it's sorted`, now);
    return r;
  });
  if (r && r.status !== "APPROVAL") await tellDesk(r, v, `${formatRequestId(r.seq)} is sorted, says ${v.name}`, r.title);
}

/** To another desk, whose people then see it and this desk's don't; its time starts again there. */
export async function moveTo(v: Viewer, id: string, deskId: string, now = new Date()): Promise<{ stillSees: boolean; fromSeq: number }> {
  const [o, desks] = await Promise.all([office(now), liveDesks()]);
  const to = desks.find((d) => d.id === deskId);
  if (!to) throw new DeskRefusal("That desk isn't taking requests.");
  const r = await holding(v, id, "desk", async (tx, r) => {
    if (r.deskId === deskId) throw new DeskRefusal("It's with that desk already.");
    if (r.status === "RESOLVED") throw new DeskRefusal("It's resolved — open it again first.");
    await withdraw(tx, id, now);
    // The old desk's people don't see it any more, so its open steps are nobody's until the new desk gives them out.
    await tx.deskRequestStep.updateMany({ where: { requestId: id, doneAt: null }, data: { assigneeId: null } });
    const assignedToId = await route(tx, deskId, r.requesterId);
    const fresh = dues(o, to.times, isLevel(r.level) ? r.level : "SLOW", now);
    await change(tx, id, { deskId, typeId: null, assignedToId, status: "OPEN", pausedAt: null, firstRepliedAt: null, replyLateToldAt: null, fixLateToldAt: null, ...fresh }, now);
    await event(tx, id, v.userId, `${v.name} moved it from ${r.desk.name} to ${to.name}`, now);
    return r;
  });
  await tellNew(id);
  await tellRequester(r, v, `${formatRequestId(r.seq)} moved to the ${deskLabel(to.name)}`, r.title);
  const target = await db.desk.findUniqueOrThrow({ where: { id: deskId }, select: { departmentId: true } });
  return { stillSees: worksAt(v, target), fromSeq: r.desk.seq };
}

// ─── Approval ────────────────────────────────────────────────────────────────────────────────────

/** One of the desk's people asks somebody to approve it: money, access, a decision. It waits, its clock stopped. */
export async function askApproval(v: Viewer, id: string, approverId: string, reason: string, now = new Date()): Promise<void> {
  const why = reason.trim();
  if (why.length < 3) throw new DeskRefusal("Say what they're asked to approve.");
  if (why.length > COMMENT_MAX) throw new DeskRefusal(`Keep it under ${COMMENT_MAX} characters.`);
  if (approverId === v.userId) throw new DeskRefusal("Ask somebody else: you can't approve what you ask for.");
  const approver = await viewerOf(approverId);
  if (!approver) throw new DeskRefusal("Choose a colleague who works here.");
  const r = await holding(v, id, "desk", async (tx, r) => {
    if (isClosed(r.status)) throw new DeskRefusal("It's resolved already.");
    if (r.status === "ASKED") throw new DeskRefusal("Somebody has been asked already.");
    if (approverId === r.requesterId) throw new DeskRefusal("Whoever asked for it can't approve it.");
    await tx.deskApproval.create({ data: { requestId: id, stage: "DESK", approverId, askedById: v.userId, reason: why, createdAt: now }, select: { id: true } });
    await change(tx, id, { status: "ASKED", ...stopClock(r, now) }, now);
    await event(tx, id, v.userId, `${v.name} asked ${approver.name} to approve it`, now);
    return r;
  });
  await notifyUser({ userId: approverId, type: "DESK_REQUEST_APPROVAL", title: `${formatRequestId(r.seq)} waits for your approval`, message: `${v.name}: ${short(why)}`, link: requestPath(r.seq) });
}

/**
 * Whoever was asked, or the super admin in their place — but nobody answers what they asked for themselves (found signed
 * in, 25 Nov 2026: the super admin, working a request, could approve their own ask).
 */
const mayAnswer = (v: Viewer, a: { approverId: string; askedById: string | null }) => a.approverId === v.userId || (v.superAdmin && a.askedById !== v.userId);

/** Approved, or not — by whoever was asked, or the super admin in their place; never by whoever made the request. */
export async function decide(v: Viewer, id: string, approve: boolean, comment: string, now = new Date()): Promise<void> {
  const said = comment.trim().slice(0, COMMENT_MAX);
  const o = await office(now);
  const done = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "desk_requests" WHERE "id" = ${id} FOR UPDATE`;
    const r = await tx.deskRequest.findUnique({ where: { id }, select: lockedSelect });
    const a = await tx.deskApproval.findFirst({ where: { requestId: id, status: "PENDING" }, select: { id: true, stage: true, approverId: true, askedById: true } });
    if (!r || r.requesterId === v.userId || !a || !mayAnswer(v, a)) throw gone();
    await tx.deskApproval.update({ where: { id: a.id }, data: { status: approve ? "APPROVED" : "REJECTED", comment: said || null, decidedById: v.userId, decidedAt: now }, select: { id: true } });
    if (a.stage === "FIRST") {
      if (approve) await change(tx, id, { status: "OPEN", assignedToId: await route(tx, r.deskId, r.requesterId), ...dues(o, readTimes(r.desk.times), isLevel(r.level) ? r.level : "SLOW", now) }, now);
      else await change(tx, id, { status: "REJECTED", resolvedAt: now }, now);
    } else await change(tx, id, { status: r.assignedToId ? "IN_PROGRESS" : "OPEN", ...startClock(o, r, now) }, now);
    await event(tx, id, v.userId, `${v.name} ${approve ? "approved it" : "didn't approve it"}`, now);
    return { r, a };
  });
  const { r, a } = done;
  const words = `${v.name} ${approve ? "approved" : "didn't approve"} ${formatRequestId(r.seq)}`;
  if (a.stage === "FIRST") {
    await tellRequester(r, v, words, said || r.title);
    if (approve) await tellNew(id);
  } else {
    for (const userId of new Set([a.askedById, r.assignedToId])) if (userId && userId !== v.userId && userId !== r.requesterId) await notifyUser({ userId, type: "DESK_REQUEST_UPDATE", title: words, message: short(said) || r.title, link: requestPath(r.seq) });
  }
}

export type WaitingApproval = { seq: number; title: string; desk: string; requester: string; reason: string; createdAt: Date };

/** What waits for this person's approval, oldest first. */
export async function approvalsWaiting(userId: string): Promise<WaitingApproval[]> {
  try {
    const rows = await db.deskApproval.findMany({ where: { approverId: userId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 100, select: { reason: true, createdAt: true, request: { select: { seq: true, title: true, desk: { select: { name: true } }, requester: { select: { name: true } } } } } });
    return rows.map((a) => ({ seq: a.request.seq, title: a.request.title, desk: a.request.desk.name, requester: a.request.requester.name, reason: a.reason, createdAt: a.createdAt }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

// ─── The desk's steps ────────────────────────────────────────────────────────────────────────────

/** A step for the desk's people, perhaps one of them's. */
export async function addStep(v: Viewer, id: string, title: string, assigneeId: string | null, now = new Date()): Promise<void> {
  const what = line(title, STEP_MAX);
  if (what.length < 2) throw new DeskRefusal("Say what the step is.");
  const r = await holding(v, id, "desk", async (tx, r) => {
    if ((await tx.deskRequestStep.count({ where: { requestId: id } })) >= STEPS_MAX) throw new DeskRefusal(`A request has at most ${STEPS_MAX} steps.`);
    const people = await peopleOf(r.desk.departmentId, tx);
    if (assigneeId && assigneeId !== r.requesterId && !people.some((p) => p.id === assigneeId) && !(v.superAdmin && assigneeId === v.userId)) throw new DeskRefusal("Choose one of the desk's people.");
    if (assigneeId && assigneeId === r.requesterId) throw new DeskRefusal("Choose one of the desk's people.");
    await tx.deskRequestStep.create({ data: { requestId: id, title: what, assigneeId, createdAt: now }, select: { id: true } });
    await change(tx, id, {}, now);
    return r;
  });
  if (assigneeId && assigneeId !== v.userId) await notifyUser({ userId: assigneeId, type: "DESK_REQUEST_NEW", title: `A step for you on ${formatRequestId(r.seq)}`, message: what, link: requestPath(r.seq) });
}

/** A step ticked, or opened again; or taken off (`null`). The request it's on, for the page. */
export async function changeStep(v: Viewer, stepId: string, done: boolean | null, now = new Date()): Promise<{ seq: number }> {
  const step = await db.deskRequestStep.findUnique({ where: { id: stepId }, select: { requestId: true } });
  if (!step) throw gone();
  const r = await holding(v, step.requestId, "desk", async (tx, r) => {
    if (done === null) await tx.deskRequestStep.deleteMany({ where: { id: stepId } });
    else await tx.deskRequestStep.updateMany({ where: { id: stepId }, data: done ? { doneAt: now, doneById: v.userId } : { doneAt: null, doneById: null } });
    await change(tx, r.id, {}, now);
    return r;
  });
  return { seq: r.seq };
}

// ─── The asset ───────────────────────────────────────────────────────────────────────────────────

/** The asset a request is about, to one of the desk's people — before it is sent anywhere: still with whoever asked. */
export async function requestAsset(v: Viewer, id: string): Promise<{ assetId: string; assetTag: string; withThem: boolean } | null> {
  const found = await findRequest(v, { id });
  if (found?.side !== "desk") return null;
  const r = await db.deskRequest.findUnique({ where: { id }, select: { requesterId: true, asset: { select: { id: true, assetTag: true, custodianUserId: true } } } });
  return r?.asset ? { assetId: r.asset.id, assetTag: r.asset.assetTag, withThem: r.asset.custodianUserId === r.requesterId } : null;
}

/** Said on the request, once the asset register has it: "Imran sent AST-00041 for repair". */
export async function noteRepair(v: Viewer, id: string, assetTag: string, now = new Date()): Promise<void> {
  await holding(v, id, "desk", async (tx, r) => {
    await event(tx, r.id, v.userId, `${v.name} sent ${assetTag} for repair`, now);
    await change(tx, r.id, {}, now);
  });
}

// ─── Today ───────────────────────────────────────────────────────────────────────────────────────

export type DeskDay = { assigned: { seq: number; title: string; from: string; late: boolean }[]; steps: { seq: number; title: string; request: string }[]; approvals: number; answers: { seq: number; title: string }[] };

/** This person's part of it today: what they have, their steps, what waits for their yes, and what waits for their answer. */
export async function deskDay(v: Viewer, now = new Date()): Promise<DeskDay> {
  const mine: Prisma.DeskRequestWhereInput = { NOT: { status: { in: [...CLOSED, ...HELD] } }, requesterId: { not: v.userId }, ...(v.superAdmin ? {} : { desk: { departmentId: v.departmentId ?? "" } }) };
  const [assigned, steps, approvals, answers] = await Promise.all([
    db.deskRequest.findMany({ where: { ...mine, assignedToId: v.userId }, orderBy: [{ fixDueAt: { sort: "asc", nulls: "last" } }, { seq: "asc" }], take: 20, select: { seq: true, title: true, status: true, replyDueAt: true, fixDueAt: true, firstRepliedAt: true, requester: { select: { name: true } } } }),
    db.deskRequestStep.findMany({ where: { assigneeId: v.userId, doneAt: null, request: mine }, orderBy: { createdAt: "asc" }, take: 20, select: { title: true, request: { select: { seq: true, title: true } } } }),
    db.deskApproval.count({ where: { approverId: v.userId, status: "PENDING" } }),
    db.deskRequest.findMany({ where: { requesterId: v.userId, status: "WAITING" }, orderBy: { lastActivityAt: "asc" }, take: 20, select: { seq: true, title: true } }),
  ]);
  return {
    assigned: assigned.map((r) => {
      const due = dueState(r, now);
      return { seq: r.seq, title: r.title, from: r.requester.name, late: (due.kind === "reply" || due.kind === "fix") && due.late };
    }),
    steps: steps.map((s) => ({ seq: s.request.seq, title: s.title, request: s.request.title })),
    approvals,
    answers,
  };
}

// ─── On the heartbeat ────────────────────────────────────────────────────────────────────────────

export type DeskSweep = { returned: number; replyLate: number; fixLate: number; approvalsMoved: number };

/**
 * Every five minutes: a request whose person has left, or left the desk's department, goes back to the desk; and one past
 * its reply or fix time is told, once each — to whoever has it, else the whole desk, and to the desk's lead.
 */
export async function deskChores(now = new Date()): Promise<DeskSweep | null> {
  if (!(await moduleAvailableForTenant("desks"))) return null;
  const out: DeskSweep = { returned: 0, replyLate: 0, fixLate: 0, approvalsMoved: 0 };
  try {
    const held = await db.deskRequest.findMany({ where: { status: { notIn: CLOSED }, assignedToId: { not: null } }, take: 2000, select: { id: true, seq: true, assignedToId: true, desk: { select: { departmentId: true } }, assignedTo: { select: { name: true, active: true, kind: true, departmentId: true, isSuperAdmin: true } } } });
    for (const r of held) {
      const p = r.assignedTo;
      if (p && p.active && p.kind === "MEMBER" && (p.isSuperAdmin || (r.desk.departmentId !== null && p.departmentId === r.desk.departmentId))) continue;
      const back = await db.$transaction(async (tx) => {
        const { count } = await tx.deskRequest.updateMany({ where: { id: r.id, assignedToId: r.assignedToId }, data: { assignedToId: null, lastActivityAt: now } });
        if (count) await event(tx, r.id, null, `Back with the desk: ${p?.name ?? "who had it"} isn't on it any more`, now);
        return count;
      });
      if (!back) continue;
      out.returned += 1;
      await tellNew(r.id);
    }
    // Asked of somebody who has left: a first approval goes to whoever it would go to now; the desk's comes back to the desk.
    const orphans = await db.deskApproval.findMany({ where: { status: "PENDING", approver: { OR: [{ active: false }, { kind: { not: "MEMBER" } }] } }, take: 200, select: { id: true, stage: true, requestId: true, request: { select: { seq: true, title: true, requesterId: true, requester: { select: { name: true } } } } } });
    const o = orphans.length ? await office(now) : null;
    for (const a of orphans) {
      if (a.stage === "FIRST") {
        const next = await approverFor(a.request.requesterId);
        if (!next || !(await db.deskApproval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { approverId: next.id } })).count) continue;
        await notifyUser({ userId: next.id, type: "DESK_REQUEST_APPROVAL", title: `${formatRequestId(a.request.seq)} waits for your approval`, message: `${a.request.requester.name}: ${a.request.title}`, link: requestPath(a.request.seq) });
      } else {
        const back = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "desk_requests" WHERE "id" = ${a.requestId} FOR UPDATE`;
          const { count } = await tx.deskApproval.updateMany({ where: { id: a.id, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: now } });
          const r = count ? await tx.deskRequest.findUnique({ where: { id: a.requestId }, select: lockedSelect }) : null;
          if (!r || r.status !== "ASKED") return false;
          await change(tx, r.id, { status: r.assignedToId ? "IN_PROGRESS" : "OPEN", ...startClock(o!, r, now) }, now);
          await event(tx, r.id, null, "Whoever was asked to approve it has left — ask somebody else", now);
          return true;
        });
        if (!back) continue;
      }
      out.approvalsMoved += 1;
    }
    const late = await db.deskRequest.findMany({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] }, OR: [{ firstRepliedAt: null, replyDueAt: { lte: now }, replyLateToldAt: null }, { fixDueAt: { lte: now }, fixLateToldAt: null }] },
      take: 500,
      select: { id: true, seq: true, title: true, requesterId: true, assignedToId: true, replyDueAt: true, fixDueAt: true, firstRepliedAt: true, replyLateToldAt: true, fixLateToldAt: true, desk: { select: { name: true, departmentId: true, leadId: true } } },
    });
    for (const r of late) {
      const fix = !!r.fixDueAt && r.fixDueAt <= now && !r.fixLateToldAt;
      // Marked first, and only if nobody else has: told once, whoever sweeps.
      const { count } = await db.deskRequest.updateMany({ where: { id: r.id, ...(fix ? { fixLateToldAt: null } : { replyLateToldAt: null }) }, data: fix ? { fixLateToldAt: now, replyLateToldAt: r.replyLateToldAt ?? now } : { replyLateToldAt: now } });
      if (!count) continue;
      const people = await peopleOf(r.desk.departmentId);
      const to = new Set(r.assignedToId ? [r.assignedToId] : people.map((p) => p.id));
      // The lead only while they're still on the desk: it's the desk's people who see its requests.
      if (r.desk.leadId && people.some((p) => p.id === r.desk.leadId)) to.add(r.desk.leadId);
      to.delete(r.requesterId);
      for (const userId of to) await notifyUser({ userId, type: "DESK_REQUEST_OVERDUE", title: `${formatRequestId(r.seq)} is past its ${fix ? "" : "first reply "}time`, message: `${deskLabel(r.desk.name)}: ${r.title}`, link: requestPath(r.seq) });
      if (fix) out.fixLate += 1;
      else out.replyLate += 1;
    }
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  return out;
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────────

export type DeskSetting = { id: string; seq: number; name: string; description: string; departmentId: string | null; routing: Routing; personId: string | null; leadId: string | null; times: Times; active: boolean; people: { id: string; name: string }[]; types: { id: string; name: string; asksAsset: boolean; approval: TypeApproval; active: boolean; used: boolean }[]; requests: number };

/** Every desk as it's set up — never what is in it. */
export async function deskSettings(): Promise<DeskSetting[]> {
  const rows = await db.desk.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], include: { types: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, asksAsset: true, approval: true, active: true, _count: { select: { requests: true } } } }, _count: { select: { requests: true } } } });
  return Promise.all(
    rows.map(async (d) => ({
      id: d.id,
      seq: d.seq,
      name: d.name,
      description: d.description ?? "",
      departmentId: d.departmentId,
      routing: (ROUTINGS as readonly string[]).includes(d.routing) ? (d.routing as Routing) : "POOL",
      personId: d.personId,
      leadId: d.leadId,
      times: readTimes(d.times),
      active: d.active,
      people: await peopleOf(d.departmentId),
      types: d.types.map((t) => ({ id: t.id, name: t.name, asksAsset: t.asksAsset, approval: readApproval(t.approval), active: t.active, used: t._count.requests > 0 })),
      requests: d._count.requests,
    })),
  );
}

export type DeskInput = { id?: string; name: string; description: string; departmentId: string; routing: string; personId: string | null; leadId: string | null; times: unknown; active: boolean; types: { id?: string; name: string; asksAsset: boolean; approval?: string; active: boolean }[] };

/** Saves a desk. A type no longer listed goes, unless a request used it — then it's only not offered any more. */
export async function saveDesk(input: DeskInput, timesWrong: string | null): Promise<{ id: string; seq: number; made: boolean }> {
  const name = line(String(input.name ?? ""), 60);
  if (name.length < 2) throw new DeskRefusal("Give the desk a name.");
  if (timesWrong) throw new DeskRefusal(timesWrong);
  const department = await db.department.findUnique({ where: { id: String(input.departmentId ?? "") }, select: { id: true } });
  if (!department) throw new DeskRefusal("Choose the department that answers.");
  if (!(ROUTINGS as readonly string[]).includes(input.routing)) throw new DeskRefusal("Choose who new requests go to.");
  const people = await peopleOf(department.id);
  const one = (id: string | null) => (id && people.some((p) => p.id === id) ? id : null);
  const personId = input.routing === "PERSON" ? one(input.personId) : null;
  if (input.routing === "PERSON" && !personId) throw new DeskRefusal("Choose which of the department's people new requests go to.");
  if (input.leadId && !one(input.leadId)) throw new DeskRefusal("Whoever is told when one is overdue has to be in the department.");
  const types = (Array.isArray(input.types) ? input.types : []).map((t) => ({ id: t.id, name: line(String(t.name ?? ""), 60), asksAsset: t.asksAsset === true, approval: readApproval(String(t.approval ?? "")), active: t.active !== false })).filter((t) => t.name);
  if (types.length > 30) throw new DeskRefusal("A desk has at most 30 types.");
  if (new Set(types.map((t) => t.name.toLowerCase())).size !== types.length) throw new DeskRefusal("Two types have the same name.");
  const same = await db.desk.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } });
  if (same) throw new DeskRefusal("There's a desk of that name already.");
  const data = { name, description: line(String(input.description ?? ""), 160) || null, departmentId: department.id, routing: input.routing, personId, leadId: one(input.leadId), times: readTimes(input.times) as unknown as Prisma.InputJsonValue, active: input.active !== false };
  return db.$transaction(async (tx) => {
    const before = input.id ? await tx.desk.findUnique({ where: { id: input.id }, select: { id: true } }) : null;
    if (input.id && !before) throw new DeskRefusal("That desk isn't there any more.");
    const desk = before ? await tx.desk.update({ where: { id: before.id }, data, select: { id: true, seq: true } }) : await tx.desk.create({ data: { ...data, sortOrder: await tx.desk.count() }, select: { id: true, seq: true } });
    const have = await tx.deskRequestType.findMany({ where: { deskId: desk.id }, select: { id: true, _count: { select: { requests: true } } } });
    const kept = new Set(types.flatMap((t) => (t.id ? [t.id] : [])));
    for (const t of have) {
      if (kept.has(t.id)) continue;
      if (t._count.requests) await tx.deskRequestType.update({ where: { id: t.id }, data: { active: false }, select: { id: true } });
      else await tx.deskRequestType.delete({ where: { id: t.id } });
    }
    for (const [i, t] of types.entries()) {
      const values = { name: t.name, asksAsset: t.asksAsset, approval: t.approval, active: t.active, sortOrder: i };
      if (t.id && have.some((h) => h.id === t.id)) await tx.deskRequestType.update({ where: { id: t.id }, data: values, select: { id: true } });
      else await tx.deskRequestType.create({ data: { deskId: desk.id, ...values }, select: { id: true } });
    }
    return { ...desk, made: !before };
  });
}

/** Only a desk nobody has asked anything goes; one with requests is switched off instead, and they stay. */
export async function deleteDesk(id: string): Promise<string> {
  const desk = await db.desk.findUnique({ where: { id }, select: { name: true, _count: { select: { requests: true } } } });
  if (!desk) throw new DeskRefusal("That desk isn't there any more.");
  if (desk._count.requests) throw new DeskRefusal("It has requests — switch it off instead, and they stay to be read.");
  try {
    await db.desk.delete({ where: { id }, select: { id: true } });
  } catch (err) {
    // Asked something a moment ago.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") throw new DeskRefusal("It has requests — switch it off instead, and they stay to be read.");
    throw err;
  }
  return desk.name;
}
