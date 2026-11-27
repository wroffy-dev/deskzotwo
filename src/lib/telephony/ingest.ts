import { revalidatePath } from "next/cache";
import type { CallOutcome, Prisma, TelephonyCall } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { phoneKey } from "@/lib/companies/duplicates";
import { STILL_THERE } from "@/lib/contacts/left";
import { contactIdsByKey, obviousLead, openLeadsFor, type PhoneMatch } from "@/lib/app/match";
import { callOutcomeLabels } from "@/lib/calls";
import type { ReportedCall } from "@/lib/telephony/types";

/**
 * A call the business's cloud telephony reported (owner, 26 Oct 2026 — src/lib/telephony), kept and logged.
 *
 *   · Every call is kept as the provider reported it (`TelephonyCall`), the customer known or not — the
 *     business line's figures count them all.
 *   · Reported twice — the live notice, the report, the call list read again — it is one call. Found by the
 *     provider's id; else a click-to-call's by its campaign id; else by the customer's number within two
 *     minutes, because CallerDesk's webhook and its call list don't always give a call the same id.
 *   · A webhook only names a call: it is believed once the provider's own call list has it (`confirmedAt`),
 *     and only then logged — so a forged notice at the webhook's address logs nothing.
 *   · Logged on Calls (source CLOUD) when its number is a contact here, as whoever took it: the agent the
 *     provider rang, else whoever asked for it from a dialog, else — a customer's call nobody answered — the
 *     company's owner, else whoever the connection sends missed calls to. A call nobody can be given stays on
 *     the line's list, as does one from a number on nobody.
 *   · A customer's call nobody answered is a callback owed, as from the Deskzo app: due at once, on the calls
 *     list and the person's tasks — once, however often they rang. Not for a call over two days old, which
 *     is history being read in, not a customer waiting.
 */

/** How far apart a webhook's and the call list's start of the same call may be. */
const SAME_CALL_MS = 2 * 60_000;
/** A click-to-call's report may start up to this long after it was asked for. */
const REQUEST_WINDOW_MS = 15 * 60_000;
/** Older than this, a missed call is history: logged, but no callback raised. */
const CALLBACK_HORIZON_MS = 2 * 86_400_000;

export type RecordResult = { id: string; logged: string | null; state: TelephonyCall["state"] };

export function outcomeOf(call: Pick<ReportedCall, "answered" | "status">): CallOutcome {
  if (call.answered) return "CONNECTED";
  if (/busy|engaged/i.test(call.status ?? "")) return "BUSY";
  return "NO_ANSWER";
}

/** The call already kept for this report, if there is one. */
async function existingFor(connectionId: string, call: ReportedCall, key: string | null, from: "webhook" | "list") {
  const byId = await db.telephonyCall.findUnique({ where: { connectionId_providerCallId: { connectionId, providerCallId: call.providerCallId } } });
  if (byId) return byId;
  if (call.campaignId) {
    const byCampaign = await db.telephonyCall.findFirst({ where: { connectionId, campaignId: call.campaignId, confirmedAt: null }, orderBy: { createdAt: "desc" } });
    if (byCampaign) return byCampaign;
  }
  if (!key) return null;
  const at = call.startedAt.getTime();
  // A report of a call already kept under the other id — the webhook's against the list's, or the reverse.
  const near = await db.telephonyCall.findFirst({
    where: { connectionId, customerKey: key, direction: call.direction, state: { not: "REQUESTED" }, startedAt: { gte: new Date(at - SAME_CALL_MS), lte: new Date(at + SAME_CALL_MS) } },
    orderBy: { startedAt: "asc" },
  });
  // Two calls from one number within the window are two calls once the list has given each its own id; a
  // webhook's id, though, may never match the list's, so a webhook takes the one already there.
  if (near && (from === "webhook" || !(near.confirmedAt && near.providerCallId && near.providerCallId !== call.providerCallId))) return near;
  // A click-to-call asked for just before.
  if (call.direction === "OUTBOUND") {
    return db.telephonyCall.findFirst({
      where: { connectionId, customerKey: key, state: "REQUESTED", createdAt: { gte: new Date(at - REQUEST_WINDOW_MS), lte: new Date(at + SAME_CALL_MS) } },
      orderBy: { createdAt: "desc" },
    });
  }
  return null;
}

/** Keeps a reported call — from a webhook, or confirmed from the provider's call list — and logs it if it's done. */
export async function recordCall(connectionId: string, call: ReportedCall, from: "webhook" | "list"): Promise<RecordResult> {
  const key = phoneKey(call.customerNumber);
  const existing = await existingFor(connectionId, call, key, from);
  // What the call list says is the call; a webhook's word doesn't change a call it has confirmed.
  if (existing?.confirmedAt && from === "webhook") return { id: existing.id, logged: existing.callLogId, state: existing.state };

  const agentKey = call.agentNumber ? phoneKey(call.agentNumber) : null;
  const agent = agentKey ? await db.telephonyAgent.findFirst({ where: { connectionId, numberKey: agentKey }, select: { userId: true } }) : null;
  const ended = !call.live;
  const data = {
    providerCallId: from === "list" || !existing?.providerCallId ? call.providerCallId : existing.providerCallId,
    campaignId: call.campaignId ?? existing?.campaignId ?? null,
    state: ended ? ("ENDED" as const) : existing?.state === "ENDED" ? ("ENDED" as const) : ("LIVE" as const),
    direction: call.direction,
    customerNumber: call.customerNumber,
    customerKey: key,
    virtualNumber: call.virtualNumber ?? existing?.virtualNumber ?? null,
    agentNumber: call.agentNumber ?? existing?.agentNumber ?? null,
    agentName: call.agentName ?? existing?.agentName ?? null,
    agentUserId: agent?.userId ?? existing?.agentUserId ?? null,
    status: call.status ?? existing?.status ?? null,
    outcome: ended ? outcomeOf(call) : null,
    startedAt: call.startedAt,
    answeredAt: call.answeredAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    talkSeconds: call.talkSeconds,
    ringSeconds: call.ringSeconds ?? existing?.ringSeconds ?? null,
    recordingUrl: call.recordingUrl ?? existing?.recordingUrl ?? null,
    callGroup: call.callGroup ?? existing?.callGroup ?? null,
    keyPressed: call.keyPressed ?? existing?.keyPressed ?? null,
    ...(from === "list" && ended ? { confirmedAt: existing?.confirmedAt ?? new Date() } : {}),
  } satisfies Prisma.TelephonyCallUncheckedUpdateInput;

  let row: TelephonyCall;
  try {
    row = existing
      ? await db.telephonyCall.update({ where: { id: existing.id }, data })
      : await db.telephonyCall.create({ data: { connectionId, ...data } });
  } catch (err) {
    // The same call arriving twice at once: the other one kept it.
    if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002")) throw err;
    const other = await db.telephonyCall.findUnique({ where: { connectionId_providerCallId: { connectionId, providerCallId: call.providerCallId } } });
    if (!other) throw err;
    return { id: other.id, logged: other.callLogId, state: other.state };
  }

  const logged = row.state === "ENDED" && row.confirmedAt && !row.callLogId ? await logCloudCall(row) : row.callLogId;
  return { id: row.id, logged, state: row.state };
}

type Found = PhoneMatch & { companyOwnerId: string | null };

/** The contact a number is, across the workspace — not a reseller's customer, still at the company. A company owned by `prefer` first, then a primary contact. */
async function contactFor(key: string, prefer: string | null): Promise<Found | null> {
  const hits = await contactIdsByKey([key]);
  if (hits.length === 0) return null;
  const contacts = await db.contact.findMany({
    where: { AND: [{ id: { in: hits.map((h) => h.id) } }, STILL_THERE, { company: { managedByResellerId: null } }] },
    select: { id: true, name: true, designation: true, isPrimary: true, company: { select: { id: true, name: true, ownerUserId: true } } },
  });
  const rank = (c: (typeof contacts)[number]) => (prefer && c.company.ownerUserId === prefer ? 0 : 2) + (c.isPrimary ? 0 : 1);
  const [best] = [...contacts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  if (!best) return null;
  return {
    key,
    contact: { id: best.id, ref: null, name: best.name, designation: best.designation },
    company: { id: best.company.id, ref: null, name: best.company.name, ownerUserId: best.company.ownerUserId },
    alsoOn: contacts.length - 1,
    companyOwnerId: best.company.ownerUserId,
  };
}

/** The ids a dialog asked about that still belong to this company — a record gone or moved since is left off. */
async function stillBelongs(companyId: string, ids: Pick<TelephonyCall, "contactId" | "leadId" | "ticketId" | "companyProductId">) {
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

/**
 * Whether the connection turns a customer's missed call into a callback (owner, 30 Oct 2026). On where it was never
 * chosen — and where the workspace hasn't the column yet, as it was before.
 */
async function incomingCallbacksOn(connectionId: string): Promise<boolean> {
  const row = await db.telephonyConnection
    .findUnique({ where: { id: connectionId }, select: { incomingCallbacks: true } })
    .catch((err) => {
      if (notMigratedYet(err)) return null;
      throw err;
    });
  return row?.incomingCallbacks ?? true;
}

const activePerson = async (id: string | null | undefined) =>
  id ? ((await db.user.findFirst({ where: { id, active: true, kind: "MEMBER" }, select: { id: true } }))?.id ?? null) : null;

/** Logs a finished, confirmed call on Calls — or leaves it on the line's list when there's nobody to give it to. */
async function logCloudCall(call: TelephonyCall): Promise<string | null> {
  const inbound = call.direction === "INBOUND";
  const missed = inbound && call.outcome !== "CONNECTED";
  const taker = (await activePerson(call.agentUserId)) ?? (await activePerson(call.requestedByUserId));

  // A call asked for from a dialog is about what the dialog was about; any other is about whoever the number is.
  let companyId: string | null = null;
  let companyName = "";
  let contactId: string | null = null;
  let context = { contactId: null as string | null, leadId: null as string | null, ticketId: null as string | null, companyProductId: null as string | null };
  let found: Found | null = null;
  if (call.companyId) {
    const company = await db.company.findUnique({ where: { id: call.companyId }, select: { id: true, name: true, ownerUserId: true } });
    if (company) {
      companyId = company.id;
      companyName = company.name;
      context = await stillBelongs(company.id, call);
      contactId = context.contactId;
    }
  }
  if (!companyId && call.customerKey) {
    found = await contactFor(call.customerKey, taker);
    if (found) {
      companyId = found.company.id;
      companyName = found.company.name;
      contactId = found.contact.id;
    }
  }
  if (!companyId) return null;

  const owner = found ? found.companyOwnerId : (await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } }))?.ownerUserId ?? null;
  const connection = missed && !taker ? await db.telephonyConnection.findUnique({ where: { id: call.connectionId }, select: { missedCallsUserId: true } }) : null;
  const person = taker ?? (missed ? ((await activePerson(owner)) ?? (await activePerson(connection?.missedCallsUserId))) : null);
  if (!person) return null;

  if (found && !context.leadId) context.leadId = obviousLead(person, found, await openLeadsFor(person, companyId));
  const outcome: CallOutcome = call.outcome ?? "NO_ANSWER";
  const recent = Date.now() - call.startedAt.getTime() < CALLBACK_HORIZON_MS;
  const owed =
    missed && recent && contactId
      ? await db.callLog.findFirst({ where: { userId: person, contactId, followUpAt: { not: null }, followUpDone: false }, select: { id: true } })
      : null;
  const raiseCallback = missed && recent && !owed && (await incomingCallbacksOn(call.connectionId));
  const who = contactId ? `${(await db.contact.findUnique({ where: { id: contactId }, select: { name: true } }))?.name ?? "them"} at ${companyName}` : companyName;

  let logged: string | null = null;
  try {
    logged = await db.$transaction(async (tx) => {
      const log = await tx.callLog.create({
        data: {
          companyId: companyId!,
          contactId,
          leadId: context.leadId,
          ticketId: context.ticketId,
          companyProductId: context.companyProductId,
          phoneNumber: call.customerNumber,
          direction: call.direction,
          outcome,
          startedAt: call.startedAt,
          durationSeconds: call.talkSeconds,
          userId: person,
          source: "CLOUD",
          followUpAt: raiseCallback ? call.startedAt : null,
        },
        select: { id: true },
      });
      if (raiseCallback) {
        const task = await tx.task.create({
          data: {
            title: `Call back ${who} — missed call`,
            description: `${call.customerNumber} rang the business line${call.virtualNumber ? ` (${call.virtualNumber})` : ""} and nobody answered.`,
            dueDate: call.startedAt,
            assignedToUserId: person,
            createdByUserId: person,
            companyId: companyId!,
            leadId: context.leadId,
          },
          select: { id: true },
        });
        await tx.callLog.update({ where: { id: log.id }, data: { followUpTaskId: task.id } });
      }
      // Logged once: a second report racing this one finds it taken and rolls back.
      const took = await tx.telephonyCall.updateMany({ where: { id: call.id, callLogId: null }, data: { callLogId: log.id } });
      if (took.count === 0) throw new AlreadyLogged();
      return log.id;
    });
  } catch (err) {
    if (err instanceof AlreadyLogged) return (await db.telephonyCall.findUnique({ where: { id: call.id }, select: { callLogId: true } }))?.callLogId ?? null;
    throw err;
  }

  const words = callOutcomeLabels[outcome].toLowerCase();
  if (context.leadId) {
    await db.activity.create({ data: { leadId: context.leadId, userId: person, type: "CALL", notes: `${words} — through the business line`, occurredAt: call.startedAt } }).catch(() => null);
  }
  await recordAudit({ userId: person, action: "CREATE", entityType: "CallLog", entityId: logged, entityLabel: `Call ${inbound ? "from" : "to"} ${companyName} — ${words}, through the business line` });
  try {
    revalidatePath("/calls");
    revalidatePath(`/companies/${companyId}`);
    if (raiseCallback) revalidatePath("/tasks");
  } catch {
    // Outside a request — the heartbeat — there's no page cache to clear.
  }
  return logged;
}

class AlreadyLogged extends Error {}
