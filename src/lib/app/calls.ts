import { revalidatePath } from "next/cache";
import { Prisma, type CallOutcome } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { ApiError } from "@/lib/api/handler";
import { iso } from "@/lib/api/refs";
import { callerCard, maskMatchNames, matchNumbers, numberKey, obviousLead, openLeadsFor, type PhoneMatch } from "@/lib/app/match";
import { noteUnmatched, probeBudgetSpent, UNMATCHED_NUMBERS_PER_DAY } from "@/lib/app/probe-cap";
import { callOutcomeLabels, callOutcomeValues } from "@/lib/calls";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { contactMasker, maskedInLists } from "@/lib/contacts/masking";
import { contactRedactor } from "@/lib/contacts/redaction";
import { requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";

/**
 * Calls from the Deskzo app (owner, 18 Oct 2026). The phone reads its own call log and sends the calls it
 * has made and taken; each one to a number on a customer this person can see is logged on the Calls module
 * as theirs — the same `CallLog` a call typed into a dialog makes — and every other one stays on the phone.
 *
 *   · Logged at once with what its length says — connected, or no answer — and waiting for its person to
 *     say how it went (the phone's after-call card, `reviewPhoneCall`).
 *   · Sent twice — a retry, a phone paired again — it is logged once.
 *   · A call the phone was asked to make from a call dialog ("Ring my phone") comes back with what that
 *     dialog was about: its contact, lead, ticket or order.
 *   · A customer's call missed is a callback owed: due now, on the calls list and the person's tasks — once,
 *     however many times they rang before it was returned.
 *   · Only calls since the phone was paired, and none from the future.
 *
 * Everything here runs as the phone's person (src/lib/app/handler.ts) and asks Calls of them as the screens do.
 */

const SYNC_MAX = 200;

export const syncBody = z.object({
  calls: z
    .array(
      z.object({
        /** The phone's own id for the call-log entry. */
        key: z.string().trim().min(1).max(100),
        number: z.string().trim().min(3).max(40),
        direction: z.enum(["out", "in"]),
        started_at: z.iso.datetime({ offset: true }),
        /** Seconds talking; 0 for a call nobody answered. */
        duration: z.number().int().min(0).max(86_400),
      }),
    )
    .min(1)
    .max(SYNC_MAX),
});

export const reviewBody = z.object({
  outcome: z.enum(callOutcomeValues as [CallOutcome, ...CallOutcome[]]),
  notes: z.string().trim().max(4000).optional(),
  /** When they asked to be called back. */
  follow_up_at: z.iso.datetime({ offset: true }).nullable().optional(),
  /** The lead it was about — one of the company's open leads this person can see; null for none. */
  lead_id: z.string().trim().max(40).nullable().optional(),
});

/** Calls one phone may log in a day (SEC-54): far more than anybody dials, far fewer than a script would send. */
export const PHONE_CALLS_PER_DAY = 600;

/** Security audit round two, 13 Nov 2026 (R2-11): said when a phone has asked about too many numbers on nobody today. */
const TOO_MANY_NUMBERS = `This phone has asked about ${UNMATCHED_NUMBERS_PER_DAY} numbers that aren't customers today — caller ID and call sync wait for tomorrow.`;

export type SyncResult ={ key: string; status: "logged" | "duplicate" | "no_match" | "too_old"; call_id?: string; contact?: string; company?: string };

async function callsUser() {
  const user = await requireModuleUser("calls");
  // In the plan is not enough: Calls switched on for the company, and View calls this person's.
  if (!(await isModuleEnabled("calls"))) throw new ApiError(403, "calls_unavailable", "You can't use Calls in Deskzo.");
  return user;
}

const outcomeWords = (outcome: CallOutcome) => callOutcomeLabels[outcome].toLowerCase();
const who = (m: PhoneMatch) => `${m.contact.name} at ${m.company.name}`;

/** What a call dialog asked this phone to dial, for a call to this number starting now — still good, not yet used. */
async function requestFor(appDeviceId: string, key: string, startedAt: Date) {
  const waiting = await db.appCallRequest.findMany({
    where: { appDeviceId, status: { in: ["WAITING", "TAKEN"] }, createdAt: { gte: new Date(startedAt.getTime() - 10 * 60_000), lte: new Date(startedAt.getTime() + 60_000) } },
    orderBy: { createdAt: "desc" },
  });
  return waiting.find((r) => numberKey(r.phoneNumber) === key) ?? null;
}

/** The ids a request carried that still belong to this company — a record gone or moved since is left off. */
async function stillBelongs(companyId: string, ids: { contactId: string | null; leadId: string | null; ticketId: string | null; companyProductId: string | null }) {
  const [contact, lead, ticket, order] = await Promise.all([
    ids.contactId ? db.contact.findUnique({ where: { id: ids.contactId }, select: { companyId: true } }) : null,
    ids.leadId ? db.lead.findUnique({ where: { id: ids.leadId }, select: { companyId: true } }) : null,
    ids.ticketId ? db.ticket.findUnique({ where: { id: ids.ticketId }, select: { companyId: true } }) : null,
    ids.companyProductId ? db.companyProduct.findUnique({ where: { id: ids.companyProductId }, select: { companyId: true } }) : null,
  ]);
  return {
    contactId: contact?.companyId === companyId ? ids.contactId : null,
    leadId: lead?.companyId === companyId ? ids.leadId : null,
    ticketId: ticket?.companyId === companyId ? ids.ticketId : null,
    companyProductId: order?.companyId === companyId ? ids.companyProductId : null,
  };
}

export async function syncPhoneCalls(device: { id: string; callSync: boolean; createdAt: Date }, body: unknown): Promise<SyncResult[]> {
  const user = await callsUser();
  if (!device.callSync) throw new ApiError(409, "call_sync_off", "Call sync is switched off on this phone.");
  const { calls } = syncBody.parse(body);

  const now = Date.now();
  // Security audit, 11 Nov 2026 (SEC-54): what the phone says is all there is, so it's held to what a phone can do —
  // at most PHONE_CALLS_PER_DAY logged a day from one phone (the rest wait; the app sends them again later).
  const loggedToday = await db.callLog.count({ where: { appDeviceId: device.id, source: "PHONE", createdAt: { gte: new Date(now - 86_400_000) } } });
  if (loggedToday >= PHONE_CALLS_PER_DAY) throw new ApiError(429, "too_many_calls", `This phone has logged ${PHONE_CALLS_PER_DAY} calls today — the rest wait for tomorrow.`);

  // Before the phone was paired, starting in the future, or still going on after now: not a call this phone made
  // (SEC-54 — an end in the future is an impossible duration).
  const inTime = (item: (typeof calls)[number]) => {
    const startedAt = new Date(item.started_at).getTime();
    const endsAt = startedAt + item.duration * 1000;
    return !(startedAt < device.createdAt.getTime() - 60_000 || startedAt > now + 5 * 60_000 || endsAt > now + 5 * 60_000);
  };
  // Security audit round two, 13 Nov 2026 (R2-11): only calls in time are matched at all, and for somebody who sees
  // phones masked the numbers that match nobody are counted against the phone's day (src/lib/app/probe-cap.ts) — so
  // call sync isn't a way to try numbers until one turns out to be a customer's.
  const phonesMasked = (await maskedInLists(user.id)).phone;
  if (phonesMasked && probeBudgetSpent(device.id)) throw new ApiError(429, "too_many_numbers", TOO_MANY_NUMBERS);
  const timely = calls.filter(inTime);
  const matches = await matchNumbers(user.id, timely.map((c) => c.number));
  if (phonesMasked) noteUnmatched(device.id, [...new Set(timely.map((c) => numberKey(c.number)).filter((k): k is string => !!k && !matches.has(k)))]);
  // What goes back to the phone: each contact's name as the Contacts list shows it to this person (R2-11).
  const shown = await maskMatchNames(user.id, matches);
  const results: SyncResult[] = [];
  const touched = new Set<string>();

  for (const item of calls) {
    const startedAt = new Date(item.started_at);
    if (!inTime(item)) {
      results.push({ key: item.key, status: "too_old" });
      continue;
    }
    const key = numberKey(item.number);
    const match = key ? matches.get(key) : undefined;
    if (!key || !match) {
      results.push({ key: item.key, status: "no_match" });
      continue;
    }
    const shownName = shown.get(key)?.contact.name ?? "";

    // Already here: from this phone under its own key, or the same call from this person's phone paired again.
    const before = await db.callLog.findFirst({
      where: {
        OR: [
          { appDeviceId: device.id, phoneCallKey: item.key },
          { userId: user.id, source: "PHONE", phoneNumber: item.number, startedAt: { gte: new Date(startedAt.getTime() - 2000), lte: new Date(startedAt.getTime() + 2000) } },
        ],
      },
      select: { id: true },
    });
    if (before) {
      results.push({ key: item.key, status: "duplicate", call_id: before.id, contact: shownName, company: match.company.name });
      continue;
    }

    const inbound = item.direction === "in";
    const outcome: CallOutcome = item.duration > 0 ? "CONNECTED" : "NO_ANSWER";
    const request = inbound ? null : await requestFor(device.id, key, startedAt);
    const context = request
      ? await stillBelongs(match.company.id, request)
      : { contactId: match.contact.id, leadId: obviousLead(user.id, match, await openLeadsFor(user.id, match.company.id)), ticketId: null, companyProductId: null };
    const contactId = context.contactId ?? match.contact.id;

    // A customer's call nobody took: a callback owed, unless one for them is already waiting on this person.
    const missed = inbound && item.duration === 0;
    const owed = missed
      ? await db.callLog.findFirst({ where: { userId: user.id, contactId, followUpAt: { not: null }, followUpDone: false }, select: { id: true } })
      : null;

    let created: { id: string } | null = null;
    try {
      created = await db.$transaction(async (tx) => {
        const call = await tx.callLog.create({
          data: {
            companyId: match.company.id,
            contactId,
            leadId: context.leadId,
            ticketId: context.ticketId,
            companyProductId: context.companyProductId,
            phoneNumber: item.number,
            direction: inbound ? "INBOUND" : "OUTBOUND",
            outcome,
            startedAt,
            durationSeconds: item.duration,
            userId: user.id,
            source: "PHONE",
            appDeviceId: device.id,
            phoneCallKey: item.key,
            followUpAt: missed && !owed ? startedAt : null,
          },
          select: { id: true },
        });
        if (missed && !owed) {
          const task = await tx.task.create({
            data: {
              title: `Call back ${who(match)} — missed call`,
              description: `${match.contact.name} rang from ${item.number} and nobody answered.`,
              dueDate: startedAt,
              assignedToUserId: user.id,
              createdByUserId: user.id,
              companyId: match.company.id,
              leadId: context.leadId,
            },
            select: { id: true },
          });
          await tx.callLog.update({ where: { id: call.id }, data: { followUpTaskId: task.id } });
        }
        if (request) await tx.appCallRequest.update({ where: { id: request.id }, data: { status: "LOGGED", callLogId: call.id } });
        return call;
      });
    } catch (err) {
      // The same call arriving twice at once: the other one logged it.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
      const other = await db.callLog.findFirst({ where: { appDeviceId: device.id, phoneCallKey: item.key }, select: { id: true } });
      results.push({ key: item.key, status: "duplicate", call_id: other?.id, contact: shownName, company: match.company.name });
      continue;
    }

    // On the lead's timeline too, as a call typed into a dialog is; its notes join it when they are given.
    if (context.leadId) {
      await db.activity
        .create({ data: { leadId: context.leadId, userId: user.id, type: "CALL", notes: `${outcomeWords(outcome)} — from the phone`, occurredAt: startedAt } })
        .catch(() => null);
    }
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "CallLog", entityId: created.id, entityLabel: `Call ${inbound ? "from" : "to"} ${match.company.name} — ${outcomeWords(outcome)}` });
    touched.add(match.company.id);
    results.push({ key: item.key, status: "logged", call_id: created.id, contact: shownName, company: match.company.name });
  }

  if (touched.size > 0) {
    revalidatePath("/calls");
    revalidatePath("/tasks");
    for (const id of touched) revalidatePath(`/companies/${id}`);
  }
  // When this phone last sent its calls, whatever came of them (owner, 31 Oct 2026: Settings › Security › Access ›
  // Phones). Never fails the sync: a workspace without the column yet just isn't told.
  await db.appDevice.update({ where: { id: device.id }, data: { lastCallSyncAt: new Date(now) }, select: { id: true } }).catch((err) => {
    if (!notMigratedYet(err)) throw err;
  });
  return results;
}

/** The phone's after-call card: how it went, what was said, a callback, the lead — for this person's own call from a phone, within a fortnight. */
export async function reviewPhoneCall(callId: string, body: unknown) {
  const user = await callsUser();
  const input = reviewBody.parse(body);
  const call = await db.callLog.findFirst({
    where: { id: callId, userId: user.id, source: "PHONE", startedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
    select: { id: true, companyId: true, contactId: true, leadId: true, startedAt: true, phoneNumber: true, followUpTaskId: true, company: { select: { name: true, ownerUserId: true, relationshipType: true } }, contact: { select: { name: true } } },
  });
  if (!call || !(await canSeeCompany(user.id, call.company))) throw new ApiError(404, "not_found", "No call of yours from this phone by that id.");

  let leadId = call.leadId;
  if (input.lead_id !== undefined) {
    if (input.lead_id === null) leadId = null;
    else {
      const open = await openLeadsFor(user.id, call.companyId);
      if (!open.some((l) => l.id === input.lead_id)) throw new ApiError(422, "refused", "That isn't one of this company's open leads you can see.", { lead_id: "not one of the company's open leads" });
      leadId = input.lead_id;
    }
  }
  if (input.outcome === "CALLBACK_REQUESTED" && !input.follow_up_at) throw new ApiError(422, "refused", "They asked to be called back — say when.", { follow_up_at: "required for a callback" });
  const followUpAt = input.follow_up_at ? new Date(input.follow_up_at) : null;
  const notes = input.notes?.trim() || null;
  const name = call.contact?.name ?? call.company.name;

  await db.$transaction(async (tx) => {
    await tx.callLog.update({ where: { id: call.id }, data: { outcome: input.outcome, notes, leadId, reviewedAt: new Date(), ...(followUpAt ? { followUpAt, followUpDone: false } : {}) } });
    if (followUpAt && call.followUpTaskId) {
      await tx.task.update({ where: { id: call.followUpTaskId }, data: { dueDate: followUpAt, done: false, doneAt: null } });
    } else if (followUpAt) {
      // Owed by whoever gave their word — as for a call typed into a dialog.
      const task = await tx.task.create({
        data: {
          title: `Call back ${name}${call.contact ? ` at ${call.company.name}` : ""}`,
          description: notes ? `Promised on the call: ${notes}` : `Promised during a call to ${call.phoneNumber}.`,
          dueDate: followUpAt,
          assignedToUserId: user.id,
          createdByUserId: user.id,
          companyId: call.companyId,
          leadId,
        },
        select: { id: true },
      });
      await tx.callLog.update({ where: { id: call.id }, data: { followUpTaskId: task.id } });
    }
  });

  // The lead's timeline: the entry made when the call came in, now with how it went; a lead picked only now gets one.
  if (leadId) {
    const text = `${outcomeWords(input.outcome)}${notes ? ` — ${notes}` : ""}`;
    const updated = await db.activity.updateMany({ where: { leadId, userId: user.id, type: "CALL", occurredAt: call.startedAt }, data: { notes: text } });
    if (updated.count === 0) await db.activity.create({ data: { leadId, userId: user.id, type: "CALL", notes: text, occurredAt: call.startedAt } }).catch(() => null);
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CallLog", entityId: call.id, entityLabel: `Call with ${call.company.name} — ${outcomeWords(input.outcome)}` });
  revalidatePath("/calls");
  if (followUpAt) revalidatePath("/tasks");
  return { id: call.id, outcome: input.outcome, follow_up_at: iso(followUpAt), lead_id: leadId };
}

/** This person's calls from their phones still waiting to be told how they went — the last three days, newest first. */
export async function callsToReview() {
  const user = await callsUser();
  const rows = await db.callLog.findMany({
    where: { userId: user.id, source: "PHONE", reviewedAt: null, startedAt: { gte: new Date(Date.now() - 3 * 86_400_000) } },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: { id: true, phoneNumber: true, direction: true, outcome: true, startedAt: true, durationSeconds: true, leadId: true, companyId: true, company: { select: { name: true } }, contact: { select: { id: true, name: true } } },
  });
  // Security audit round two, 13 Nov 2026 (R2-11): each contact's name as the Contacts list shows it to this person.
  // The number stays: it is the phone's own call, which the phone already has.
  const m = await contactMasker(user.id, "list", rows.flatMap((r) => (r.contact ? [r.contact.id] : [])));
  const leads = new Map<string, Awaited<ReturnType<typeof openLeadsFor>>>();
  for (const companyId of new Set(rows.map((r) => r.companyId))) leads.set(companyId, await openLeadsFor(user.id, companyId));
  return rows.map((r) => ({
    id: r.id,
    number: r.phoneNumber,
    direction: r.direction === "INBOUND" ? "in" : "out",
    outcome: r.outcome,
    started_at: iso(r.startedAt),
    duration: r.durationSeconds,
    contact: r.contact ? m.present(r.contact.id, "name", r.contact.name) : null,
    company: r.company.name,
    lead_id: r.leadId,
    open_leads: (leads.get(r.companyId) ?? []).map((l) => ({ id: l.id, ref: l.ref, title: l.title, stage: l.stage })),
  }));
}

/**
 * This person's callbacks still owed, soonest first.
 *
 * Each contact's number and name as their contacts policy shows them in a list (owner, 5 Nov 2026 — Phase 3 masking
 * fixes; src/lib/contacts/masking.ts), and the notes quoting them redacted, as the Calls list masks a call's number
 * (src/actions/call.ts `maskDialled`) and the Activity feed its notes. A number on nobody is shown as dialled.
 */
export async function dueCallbacks() {
  const user = await callsUser();
  const rows = await db.callLog.findMany({
    where: { userId: user.id, followUpAt: { not: null }, followUpDone: false },
    orderBy: { followUpAt: "asc" },
    take: 50,
    select: { id: true, phoneNumber: true, followUpAt: true, notes: true, company: { select: { name: true } }, contact: { select: { id: true, name: true, phone: true } } },
  });
  const m = await contactMasker(user.id, "list", rows.flatMap((r) => (r.contact ? [r.contact.id] : [])));
  return rows.map((r) => {
    const number = r.contact?.phone ?? r.phoneNumber;
    if (!r.contact || !m.active) return { id: r.id, due_at: iso(r.followUpAt), number, contact: r.contact?.name ?? null, company: r.company.name, notes: r.notes };
    const c = r.contact;
    const redact = contactRedactor(m, c.id, [["name", c.name], ["phone", c.phone], ["phone", r.phoneNumber]]);
    return { id: r.id, due_at: iso(r.followUpAt), number: m.present(c.id, "phone", number) ?? "", contact: m.present(c.id, "name", c.name), company: r.company.name, notes: redact(r.notes) };
  });
}

/**
 * Caller ID: who a number is, as this person may see them, or null.
 *
 * Security audit round two, 13 Nov 2026 (R2-11): the contact's name as the Contacts list shows it to them, and for
 * somebody who sees phones masked, numbers on nobody count against the phone's day (src/lib/app/probe-cap.ts). The
 * request can't prove a call is ringing — caller ID is asked before the call is synced — so the cap is the guard.
 */
export async function lookupNumber(number: string, appDeviceId: string) {
  const user = await callsUser();
  const key = numberKey(number);
  if (!key) return null;
  const phonesMasked = (await maskedInLists(user.id)).phone;
  if (phonesMasked && probeBudgetSpent(appDeviceId)) throw new ApiError(429, "too_many_numbers", TOO_MANY_NUMBERS);
  const matches = await matchNumbers(user.id, [number]);
  if (phonesMasked && !matches.has(key)) noteUnmatched(appDeviceId, [key]);
  const match = (await maskMatchNames(user.id, matches)).get(key);
  return match ? callerCard(user.id, match) : null;
}

/**
 * The calls a call dialog asked this phone to make, still good — handed over once each: taken now, so the
 * next look doesn't offer them again.
 */
export async function takeCallRequests(appDeviceId: string) {
  await callsUser();
  const now = new Date();
  await db.appCallRequest.updateMany({ where: { appDeviceId, status: { in: ["WAITING", "TAKEN"] }, expiresAt: { lt: now } }, data: { status: "EXPIRED" } });
  const waiting = await db.appCallRequest.findMany({ where: { appDeviceId, status: "WAITING" }, orderBy: { createdAt: "asc" }, select: { id: true, phoneNumber: true, label: true, createdAt: true } });
  if (waiting.length > 0) await db.appCallRequest.updateMany({ where: { id: { in: waiting.map((w) => w.id) }, status: "WAITING" }, data: { status: "TAKEN", takenAt: now } });
  return waiting.map((w) => ({ id: w.id, number: w.phoneNumber, label: w.label, asked_at: iso(w.createdAt) }));
}
