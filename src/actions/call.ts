"use server";

import { pageSlice } from "@/lib/pagination";
import { revalidatePath } from "next/cache";
import { contactMasker, dialledNumber, maskContactRows } from "@/lib/contacts/masking";
import type { CallOutcome, CallDirection, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { leadsSeenBy } from "@/lib/leads/shown";
import { STILL_THERE } from "@/lib/contacts/left";
import { playableCalls } from "@/lib/calls/recordings";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { toPlain } from "@/lib/serialize";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { contactScope } from "@/lib/authz/contact-access";
import { callAccess, peopleReached, throughAccount } from "@/lib/authz/access";
import { callOutcomeValues, isConnected } from "@/lib/calls";
import type { ActionResult } from "@/actions/company";
import { clip, TEXT_MAX } from "@/lib/text/bounded";
import { viewerHas } from "@/actions/permission";
import { isModuleEnabled } from "@/actions/module";
import { workspaceClock } from "@/lib/time/workspace";
import { cloudExtras } from "@/lib/telephony/access";

const callSelect = {
  id: true,
  phoneNumber: true,
  direction: true,
  outcome: true,
  startedAt: true,
  durationSeconds: true,
  notes: true,
  source: true,
  reviewedAt: true,
  followUpAt: true,
  followUpDone: true,
  createdAt: true,
  company: { select: { id: true, name: true, relationshipType: true, companySeq: true } },
  contact: { select: { id: true, name: true, designation: true } },
  lead: { select: { id: true, title: true, leadSeq: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
  companyProduct: { select: { id: true, orderSeq: true, item: { select: { name: true } } } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.CallLogSelect;

/**
 * Records a call.
 *
 * Everything except the company and the outcome is optional, deliberately: a caller who has just
 * put the phone down will log what happened if it takes five seconds, and will stop logging
 * entirely if the form insists on a duration and a note every time.
 */
const NOT_CALLS = "You can't log calls here.";

/**
 * Whether this person may log a call here — Calls switched on for the company, and View calls theirs
 * (`isModuleEnabled` asks both). The phone icon asks once a page and hides itself otherwise, wherever
 * it is drawn; logCall asks again whatever the icon did.
 */
export async function callsAllowed(): Promise<boolean> {
  try {
    // Signed in, and Calls in the plan: outside it the answer is simply no, never a thrown refusal
    // that every icon on the page would ask again.
    await requireModuleUser("calls");
  } catch {
    return false;
  }
  return isModuleEnabled("calls");
}

export async function logCall(input: {
  companyId: string;
  contactId?: string;
  phoneNumber: string;
  outcome: string;
  direction?: string;
  startedAt?: string;
  durationSeconds?: number | string;
  notes?: string;
  followUpAt?: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("calls");
  // In the plan is not enough: Calls switched on for the company, and View calls this person's.
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };

  if (!callOutcomeValues.includes(input.outcome as CallOutcome)) {
    return { ok: false, error: "Pick how the call went." };
  }
  // A masked number is logged as the contact's own, looked up here (src/lib/contacts/masking.ts).
  // Capped (owner, 15 Nov 2026 — input bounds): a number sent unmasked comes back as sent; the notes also go on the
  // follow-up task and the lead's activity.
  const phoneNumber = input.phoneNumber?.trim() ? clip((await dialledNumber(user.id, { phoneNumber: input.phoneNumber, contactId: input.contactId, companyId: input.companyId })).number, TEXT_MAX.phone) : "";
  if (!phoneNumber) return { ok: false, error: "A call needs the number that was dialled." };
  const notes = clip(input.notes, TEXT_MAX.notes);

  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
  // A call is logged on a company the caller reaches — one they couldn't then see is missing to them.
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "That company no longer exists." };
  // What it is also about must be this company's: a lead, ticket or order from another account would
  // put this call on that account's timeline.
  const belongs = async (found: { companyId: string } | null) => !!found && found.companyId === company.id;
  if (input.leadId && !(await belongs(await db.lead.findUnique({ where: { id: input.leadId }, select: { companyId: true } })))) {
    return { ok: false, error: "That lead isn't this company's." };
  }
  if (input.ticketId && !(await belongs(await db.ticket.findUnique({ where: { id: input.ticketId }, select: { companyId: true } })))) {
    return { ok: false, error: "That ticket isn't this company's." };
  }
  if (input.companyProductId && !(await belongs(await db.companyProduct.findUnique({ where: { id: input.companyProductId }, select: { companyId: true } })))) {
    return { ok: false, error: "That order isn't this company's." };
  }

  if (input.contactId) {
    const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== company.id) {
      return { ok: false, error: "That contact doesn't belong to this company." };
    }
  }

  const duration = Math.max(0, Math.round(Number(input.durationSeconds) || 0));
  // A time typed into the dialog is the workspace's time, wherever the server is; one a page worked out
  // and sent with its zone is taken as it says.
  const clock = await workspaceClock();
  const startedAt = input.startedAt ? clock.parseTyped(input.startedAt) : new Date();
  if (!startedAt) return { ok: false, error: "That start time isn't a valid date." };

  const followUpAt = input.followUpAt ? clock.parseTyped(input.followUpAt) : null;
  if (input.followUpAt && !followUpAt) {
    return { ok: false, error: "That callback time isn't a valid date." };
  }

  const contactName = input.contactId
    ? (await db.contact.findUnique({ where: { id: input.contactId }, select: { name: true } }))?.name ?? null
    : null;

  const call = await db.$transaction(async (tx) => {
    const created = await tx.callLog.create({
      data: {
        companyId: company.id,
        contactId: input.contactId || null,
        leadId: input.leadId || null,
        ticketId: input.ticketId || null,
        companyProductId: input.companyProductId || null,
        phoneNumber,
        direction: (input.direction as CallDirection) ?? "OUTBOUND",
        outcome: input.outcome as CallOutcome,
        startedAt,
        durationSeconds: duration,
        notes: notes || null,
        followUpAt,
        userId: user.id,
      },
      select: { id: true },
    });

    if (followUpAt) {
      // Assigned to whoever made the promise — a callback is owed by the person who gave their word,
      // not by whoever happens to own the account.
      const task = await tx.task.create({
        data: {
          title: `Call back ${contactName ?? company.name}${contactName ? ` at ${company.name}` : ""}`,
          description: notes
            ? `Promised on the call: ${notes}`
            : `Promised during a call to ${phoneNumber}.`,
          dueDate: followUpAt,
          assignedToUserId: user.id,
          createdByUserId: user.id,
          companyId: company.id,
          leadId: input.leadId || null,
          ticketId: input.ticketId || null,
        },
        select: { id: true },
      });
      await tx.callLog.update({ where: { id: created.id }, data: { followUpTaskId: task.id } });
    }

    return created;
  });

  // A call against a lead is also part of that lead's story, so it goes on the timeline the lead
  // page already shows rather than being visible only under Calls.
  if (input.leadId) {
    await db.activity
      .create({
        data: {
          leadId: input.leadId,
          userId: user.id,
          type: "CALL",
          notes: `${input.outcome.replaceAll("_", " ").toLowerCase()}${notes ? ` — ${notes}` : ""}`,
          occurredAt: startedAt,
        },
      })
      .catch(() => null);
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CallLog",
    entityId: call.id,
    entityLabel: `Call to ${company.name} — ${input.outcome.replaceAll("_", " ").toLowerCase()}`,
  });

  revalidatePath("/calls");
  if (followUpAt) revalidatePath("/tasks");
  revalidatePath(`/companies/${company.id}`);
  if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
  if (input.ticketId) revalidatePath(`/tickets/${input.ticketId}`);
  return { ok: true, data: call };
}

/** Marks a promised callback as done, without deleting the promise that was made. */
export async function completeFollowUp(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };
  // A call this person may see — its company and its caller — and change (src/lib/authz/access.ts, "activities").
  const call = await db.callLog.findFirst({
    where: { AND: [{ id }, await throughAccount(user.id, "view"), await callAccess(user.id, "edit")] },
    select: { id: true, followUpAt: true, followUpTaskId: true },
  });
  if (!call) return { ok: false, error: "That call no longer exists." };
  if (!call.followUpAt) return { ok: false, error: "There's no callback set on that call." };

  await db.$transaction(async (tx) => {
    await tx.callLog.update({ where: { id }, data: { followUpDone: true } });
    if (call.followUpTaskId) {
      await tx.task.update({
        where: { id: call.followUpTaskId },
        data: { done: true, doneAt: new Date() },
      });
    }
  });
  revalidatePath("/calls");
  revalidatePath("/tasks");
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CallLog", entityId: id, entityLabel: "Callback done" });
  return { ok: true, data: null };
}

/**
 * Deleting a logged call: the workspace's super admin's alone (owner, 27 Oct 2026), never while viewing as
 * someone else. Its callback task goes with it unless that was already done; a business-line call keeps its
 * recording, just without the log (TelephonyCall.callLogId sets null).
 */
export async function deleteCall(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("calls");
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can delete calls." };
  const call = await db.callLog.findUnique({
    where: { id: String(id ?? "") },
    select: { id: true, phoneNumber: true, startedAt: true, followUpTaskId: true, company: { select: { name: true } } },
  });
  if (!call) return { ok: false, error: "That call no longer exists." };
  await db.$transaction(async (tx) => {
    await tx.callLog.delete({ where: { id: call.id } });
    if (call.followUpTaskId) await tx.task.deleteMany({ where: { id: call.followUpTaskId, done: false } });
  });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CallLog",
    entityId: call.id,
    entityLabel: `Deleted the call to ${call.company.name} (${call.phoneNumber}) on ${(await workspaceClock()).dateTimeShort(call.startedAt)}`,
  });
  revalidatePath("/calls");
  revalidatePath("/tasks");
  return { ok: true, data: null };
}

/**
 * The numbers a caller can reach this company on, primary contact first.
 *
 * Contacts only — a company has no number of its own in this model, and offering an empty
 * switchboard field would just be a box to ignore.
 */
export async function listCompanyNumbers(companyId: string) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return [];

  /**
   * Never a reseller's end customer.
   *
   * `src/lib/reseller.ts` states the rule the whole arrangement rests on — no direct calls, no
   * direct email — and this handed back the phone numbers and addresses anyway, to a dialler.
   * Enforced here rather than trusted to the caller: this is the one function in the module whose
   * entire output is contact details.
   */
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { managedByResellerId: true, ownerUserId: true, relationshipType: true },
  });
  if (!company || company.managedByResellerId) return [];

  /**
   * And never an account somebody does not manage.
   *
   * A separate rule from the one above and stacked on purpose: the reseller check asks whether
   * *anybody here* may ring this customer, the account scope asks whether *this* person may. The id
   * arrives from the caller, so there is nothing to filter — refuse, as `canSeeCompany` exists for.
   * Same empty result as a reseller's customer, so the dialler cannot tell the two apart.
   */
  if (!(await canSeeCompany(user.id, company))) return [];

  /**
   * And only the people this person may see (owner, 3 Nov 2026 — Phase 2 permission fixes, audit H-4): `contacts.view`
   * and the Contacts record level (`contactScope`), as the company's Contacts tab asks. `calls.view` alone handed every
   * contact's phone and email to the dialler, whatever the role editor said about contacts. The company is the company
   * rule's, asked above; it has no number of its own to offer.
   */
  const contacts = await db.contact.findMany({
    where: { AND: [{ companyId, phone: { not: null }, ...STILL_THERE }, await contactScope(user.id)] },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, designation: true, phone: true, email: true, isPrimary: true },
  });
  // As this person sees them in a list (owner, 3 Nov 2026): a masked number is dialled by the server from the contact.
  return toPlain(await maskContactRows(user.id, "list", contacts));
}

export async function listCalls(params: {
  page: number;
  pageSize: number;
  search?: string;
  outcome?: string;
  userId?: string;
  from?: string;
  to?: string;
  /** "due" narrows to callbacks that are promised and not yet done. */
  view?: string;
}) {
  const user = await requireModuleAccess("calls");
  if (!(await viewerHas("calls.view"))) return { rows: [], total: 0 };

  // From and To are the workspace's days.
  const days = (await workspaceClock()).dayRange(params.from, params.to);
  const where: Prisma.CallLogWhereInput = {
    /**
     * Scoped by the account, and by the caller.
     *
     * `CallLog.companyId` is required, so every call hangs off a company and the account manager of
     * that company is who it belongs to — the one-hop `company.ownerUserId` path, same as leads and
     * tickets. What leaks without that is the number dialled and the note taken afterwards, which are
     * the customer's, not the caller's.
     *
     * And then whose calls (owner, 8 Oct 2026): their own and their team's, or everybody's with "See
     * everyone's calls, notes & meetings". The `userId` parameter stays a filter chosen inside that.
     */
    // Both under AND — the company's rule and whose calls (src/lib/authz/access.ts, "activities") — so
    // the caller filter below narrows them rather than replacing either.
    AND: [await throughAccount(user.id, "view"), await callAccess(user.id, "view")],
    ...(params.outcome && callOutcomeValues.includes(params.outcome as CallOutcome)
      ? { outcome: params.outcome as CallOutcome }
      : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.view === "due" ? { followUpAt: { not: null }, followUpDone: false } : {}),
    ...(days ? { startedAt: days } : {}),
    ...(params.search
      ? {
          OR: [
            { company: { name: { contains: params.search, mode: "insensitive" } } },
            { contact: { name: { contains: params.search, mode: "insensitive" } } },
            { phoneNumber: { contains: params.search } },
            { notes: { contains: params.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.callLog.findMany({
      where,
      // Due callbacks read soonest-first; everything else newest-first.
      orderBy: params.view === "due" ? { followUpAt: "asc" } : { startedAt: "desc" },
      ...pageSlice(params.page, params.pageSize),
      select: callSelect,
    }),
    db.callLog.count({ where }),
  ]);

  return toPlain({ rows: await maskDialled(user.id, await withCloud(user.id, await leadsSeenBy(user.id, rows))), total });
}

/**
 * The number on each call, as this person sees the contact's phone in a list (owner, 3 Nov 2026): a call to a
 * contact whose phone is masked for them shows the number masked too, or the call log would list what the Contacts
 * page hides. A call to a number on nobody is shown as dialled.
 */
async function maskDialled<T extends { phoneNumber: string; contact: { id: string } | null }>(viewerId: string, rows: T[]) {
  const masker = await contactMasker(viewerId, "list", rows.flatMap((r) => (r.contact ? [r.contact.id] : [])));
  if (!masker.active) return rows;
  return rows.map((r) => (r.contact ? { ...r, phoneNumber: masker.present(r.contact.id, "phone", r.phoneNumber) ?? r.phoneNumber } : r));
}

/**
 * A recording to play and whether its person may still say how it went, on each call through the business line
 * (src/lib/telephony/access.ts) — asked beside the list, so cloud calling failing shows nothing rather than no calls.
 */
async function withCloud<T extends { id: string; source: string; startedAt: Date; reviewedAt: Date | null; user: { id: string } }>(viewerId: string, rows: T[]) {
  const [extras, recorded] = await Promise.all([cloudExtras(viewerId, rows), playableCalls(viewerId, rows.map((r) => ({ id: r.id, userId: r.user.id })))]);
  // And a phone call's own recording, from the phone's recorder (src/lib/calls/recordings.ts), for whoever may hear it.
  return rows.map((r) => ({ ...r, cloud: extras.get(r.id) ?? null, phoneRecording: recorded.has(r.id) }));
}

/** Headline figures for the calling team: dials, how many reached a person, and time on the phone. */
export async function callSummary(params?: { from?: string; to?: string; userId?: string }) {
  const user = await requireModuleAccess("calls");
  if (!(await viewerHas("calls.view"))) return { total: 0, connected: 0, connectRate: 0, talkTimeSeconds: 0, companiesReached: 0, dueCallbacks: 0 };
  // Today unless told otherwise — the workspace's today, not the server's: on a server in UTC, a team in
  // India had a day that began at 05:30.
  const clock = await workspaceClock();
  const today = clock.today();
  const days = clock.dayRange(params?.from || today, params?.to || today) ?? {};

  // Both queries, not just the first. The overdue-callback tally is a second read of the same table
  // and counts the whole business unless it is scoped too — a number nobody would think to doubt,
  // and one that tells a sales executive how many customers they cannot see are waiting on a call.
  // Whose calls under AND, so the caller filter narrows it rather than replacing it.
  const scope: Prisma.CallLogWhereInput = { AND: [await throughAccount(user.id, "view"), await callAccess(user.id, "view")] };

  const [calls, dueCount] = await Promise.all([
    db.callLog.findMany({
      where: { ...scope, startedAt: days, ...(params?.userId ? { userId: params.userId } : {}) },
      select: { outcome: true, durationSeconds: true, companyId: true },
    }),
    db.callLog.count({ where: { ...scope, followUpAt: { not: null, lte: new Date() }, followUpDone: false } }),
  ]);

  const connected = calls.filter((c) => isConnected(c.outcome)).length;
  return {
    total: calls.length,
    connected,
    // The figure a floor manager actually watches — dialling more doesn't help if nobody answers.
    connectRate: calls.length > 0 ? Math.round((connected / calls.length) * 100) : 0,
    talkTimeSeconds: calls.reduce((t, c) => t + c.durationSeconds, 0),
    companiesReached: new Set(calls.filter((c) => isConnected(c.outcome)).map((c) => c.companyId)).size,
    dueCallbacks: dueCount,
  };
}

/** A company's call history, for the 360 view. */
export async function listCompanyCalls(companyId: string, take = 50) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return [];
  const rows = await db.callLog.findMany({
    // Scoped as well as filtered by id. Every row here shares one company, so the scope is
    // all-or-nothing and reads as the refusal it is: without it, a company id — which is not a
    // secret — is enough to read the call notes on an account somebody else manages.
    where: { AND: [{ companyId }, await throughAccount(user.id, "view"), await callAccess(user.id, "view")] },
    orderBy: { startedAt: "desc" },
    take,
    select: callSelect,
  });
  return toPlain(await withCloud(user.id, await leadsSeenBy(user.id, rows)));
}

/**
 * The names in the "caller" filter. Our own staff, so deliberately not account-scoped: narrowing it
 * to colleagues who happened to ring your accounts would hide nothing a customer owns and would
 * leave the filter offering a different set of names on every page. Narrowed to the callers whose
 * calls this person sees, though — a name whose calls never show is a filter that only empties.
 */
export async function listCallers() {
  const user = await requireModuleAccess("calls");
  const callers = await peopleReached(user.id, "activities", "view");
  return db.user.findMany({
    where: { active: true, callsLogged: { some: {} }, ...(callers ? { id: { in: callers } } : {}) },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
