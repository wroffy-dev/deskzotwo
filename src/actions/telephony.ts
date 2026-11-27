"use server";

import { randomBytes } from "node:crypto";
import { plainError } from "@/lib/plain-error";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { CallOutcome, TelephonyCallState } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAccessFor, requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { peopleReached } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { decryptSecret, digestSecret, encryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { PEOPLE_ONLY } from "@/lib/people";
import { phoneKey } from "@/lib/companies/duplicates";
import { callOutcomeLabels, callOutcomeValues, hasDialableNumber } from "@/lib/calls";
import { REVIEW_DAYS } from "@/lib/telephony/access";
import { workspaceClock } from "@/lib/time/workspace";
import { callerdesk, callerdeskDay } from "@/lib/telephony/callerdesk";
import { activeConnection, connectionKey } from "@/lib/telephony/connection";
import { syncConnection } from "@/lib/telephony/sync";
import { buildLineReport, type LaterCall, type LineReport } from "@/lib/telephony/report";
import { balanceWarning, PROVIDER_NAMES, TelephonyError, type TelephonyBalance, type TelephonyMember } from "@/lib/telephony/types";
import { dialledNumber } from "@/lib/contacts/masking";
import type { ActionResult } from "@/actions/company";

/**
 * Cloud calling (owner, 26 Oct 2026 — src/lib/telephony): the business's CallerDesk account.
 *
 *   · Settings › Cloud calling — connecting it, who on the team is which CallerDesk member, who missed calls
 *     go to, the webhook's address — is `settings.manage`, as the catalogue gates the page, where Calls is on.
 *   · "Call through CallerDesk" in a call dialog: whoever is a member, for a customer they can see, never as
 *     somebody else nor to a reseller's customer — as "Ring my phone" (src/actions/phone-calls.ts).
 *   · Calls › Business line: the line's figures within the viewer's reach — every call where their reach is
 *     everybody's, else the calls of the people they reach.
 */

const SETTINGS_DENIED = "Only somebody who manages settings can change cloud calling.";
const NOT_CALLS = "You can't use Calls here.";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_MAX_DAYS = 92;

async function settingsUser() {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) return { user, error: NOT_CALLS };
  if (!(await can(user.id, "settings.manage"))) return { user, error: SETTINGS_DENIED };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { user, error: viewingAs };
  return { user, error: null };
}

const webhookAddress = async (token: string) => `${await tenantOrigin()}/api/telephony/callerdesk/${token}`;
const newToken = () => randomBytes(24).toString("base64url");
const failure = (err: unknown) => (err instanceof TelephonyError ? err.message : plainError(err, "no reason given"));

// ─── Settings ────────────────────────────────────────────────────────────────────────────────

export type TelephonyAgentView = { userId: string; name: string; memberId: string; memberName: string; memberNumber: string };

export type TelephonyView = {
  migrated: boolean;
  connection: {
    provider: "CALLERDESK";
    name: string;
    deskphone: string;
    accountName: string | null;
    webhookUrl: string;
    connectedAt: Date;
    lastSyncAt: Date | null;
    syncedThrough: Date | null;
    lastError: string | null;
    missedCallsUserId: string | null;
    /** Incoming: a customer's missed call becomes a callback. Outgoing is `deskphone` — empty, none. */
    incomingCallbacks: boolean;
    callsKept: number;
    /** Asked of CallerDesk as the page opens — null when it didn't answer. */
    balance: (TelephonyBalance & { warning: string | null }) | null;
  } | null;
  agents: TelephonyAgentView[];
  people: { id: string; name: string; phone: string | null }[];
};

export async function telephonyView(): Promise<ActionResult<TelephonyView>> {
  const { error } = await settingsUser();
  if (error) return { ok: false, error };
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true, phone: true } });
  let row;
  try {
    row = await db.telephonyConnection.findFirst({
      where: { active: true },
      select: {
        id: true,
        provider: true,
        deskphone: true,
        accountName: true,
        webhookTokenEnc: true,
        connectedAt: true,
        lastSyncAt: true,
        syncedThrough: true,
        lastError: true,
        missedCallsUserId: true,
        incomingCallbacks: true,
        agents: { select: { userId: true, memberId: true, memberName: true, memberNumber: true, user: { select: { name: true } } }, orderBy: { memberName: "asc" } },
        _count: { select: { calls: true } },
      },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: { migrated: false, connection: null, agents: [], people } };
    throw err;
  }
  if (!row) return { ok: true, data: { migrated: true, connection: null, agents: [], people } };
  // The balance as the page opens; CallerDesk not answering is no balance shown, never a page that fails.
  const key = await connectionKey(row.id).catch(() => null);
  const balance = key
    ? await callerdesk
        .balance(key)
        .then((b) => ({ ...b, warning: balanceWarning(b) }))
        .catch(() => null)
    : null;
  return {
    ok: true,
    data: {
      migrated: true,
      connection: {
        provider: row.provider,
        name: PROVIDER_NAMES[row.provider],
        deskphone: row.deskphone,
        accountName: row.accountName,
        webhookUrl: await webhookAddress(await decryptSecret(row.webhookTokenEnc)),
        connectedAt: row.connectedAt,
        lastSyncAt: row.lastSyncAt,
        syncedThrough: row.syncedThrough,
        lastError: row.lastError,
        missedCallsUserId: row.missedCallsUserId,
        incomingCallbacks: row.incomingCallbacks,
        callsKept: row._count.calls,
        balance,
      },
      agents: row.agents.map((a) => ({ userId: a.userId, name: a.user.name, memberId: a.memberId, memberName: a.memberName, memberNumber: a.memberNumber })),
      people,
    },
  };
}

const connectSchema = z.object({
  authCode: z.string().trim().max(200).default(""),
  deskphone: z.string().trim().max(30).default(""),
  /**
   * What it does here (owner, 30 Oct 2026: "all options… incoming, outgoing, only reports"). Calls and recordings
   * always come in. Outgoing: Call buttons ring through it — off, no business number is kept. Incoming: a
   * customer's missed call becomes a callback. Both off is reports only.
   */
  outgoing: z.boolean().default(true),
  incomingCallbacks: z.boolean().default(true),
});

/** What CallerDesk's refusal means, in words that point at the right fix. */
function keyRefused(err: unknown): string {
  const why = failure(err);
  if (/inactive|deactivat|suspend|expired/i.test(why)) {
    return `CallerDesk says this account isn't active (${why}). The key was found — ask CallerDesk to activate the account and its API access, then connect again.`;
  }
  return `CallerDesk didn't accept that key (${why}). Check you copied it whole.`;
}

/**
 * Connects CallerDesk, or changes its key or number: the key is tried, and the number has to be one of the
 * account's, before anything is kept — so a typo shows here, not on the first call.
 *
 * Without outgoing, the key is tried on the call list — all bringing calls in needs — and no business number is kept
 * (`deskphone` empty), so nothing rings through it: Call buttons stay as they were, and every call on the account,
 * its recording with it, still comes in.
 */
export async function connectCallerdesk(input: unknown): Promise<ActionResult<{ numbers: string[] }>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const parsed = connectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the details." };
  const existing = await db.telephonyConnection.findUnique({ where: { provider: "CALLERDESK" } });
  const authCode = parsed.data.authCode || (existing?.active && existing.authCodeEnc ? await decryptSecret(existing.authCodeEnc) : "");
  if (authCode.length < 8) return { ok: false, error: "Enter the API key from CallerDesk (API & Integration › API key)." };

  let accountName: string | null;
  let numbers: string[];
  const { outgoing, incomingCallbacks } = parsed.data;
  if (!outgoing) {
    try {
      await callerdesk.callsOn(authCode, callerdeskDay(new Date()), 1);
    } catch (err) {
      return { ok: false, error: keyRefused(err) };
    }
    // Its name, where CallerDesk tells it; nothing is refused for want of it.
    accountName = await callerdesk
      .account(authCode)
      .then((a) => a.name)
      .catch(() => null);
    numbers = [];
  } else {
    try {
      accountName = (await callerdesk.account(authCode)).name;
      numbers = await callerdesk.numbers(authCode);
    } catch (err) {
      return { ok: false, error: keyRefused(err) };
    }
  }
  const typed = parsed.data.deskphone.replace(/\s+/g, "");
  const deskphone = !outgoing ? "" : typed ? (numbers.find((n) => n === typed || phoneKey(n) === phoneKey(typed)) ?? null) : (numbers[0] ?? null);
  if (deskphone === null) {
    return {
      ok: false,
      error: numbers.length
        ? `${typed} isn't one of this account's numbers — it has ${numbers.join(", ")}.`
        : "This CallerDesk account has no virtual number yet. Add one in CallerDesk first.",
    };
  }

  const token = existing?.active && existing.webhookTokenEnc ? null : newToken();
  const data = {
    authCodeEnc: await encryptSecret(authCode),
    deskphone,
    accountName,
    active: true,
    checkedAt: new Date(),
    lastError: null,
    ...(token ? { webhookTokenHash: await digestSecret(token), webhookTokenEnc: await encryptSecret(token) } : {}),
  };
  const saved = existing
    ? await db.telephonyConnection.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.telephonyConnection.create({
        data: { provider: "CALLERDESK", connectedByUserId: user.id, ...data, webhookTokenHash: data.webhookTokenHash!, webhookTokenEnc: data.webhookTokenEnc! },
        select: { id: true },
      });
  // Named on its own, so the key and number save even where the column is still to come.
  await db.telephonyConnection.update({ where: { id: saved.id }, data: { incomingCallbacks }, select: { id: true } }).catch((err) => {
    if (!notMigratedYet(err)) throw err;
  });
  const does = [deskphone ? `outgoing from ${deskphone}` : null, incomingCallbacks ? "missed calls as callbacks" : null, "calls and recordings"].filter(Boolean).join(", ");
  await recordAudit({
    userId: user.id,
    action: existing?.active ? "UPDATE" : "CREATE",
    entityType: "TelephonyConnection",
    entityId: "CALLERDESK",
    entityLabel: `CallerDesk ${existing?.active ? "updated" : "connected"} for cloud calling — ${does}${accountName ? ` (${accountName})` : ""}`,
  });
  revalidatePath("/settings/telephony");
  return { ok: true, data: { numbers } };
}

/** Disconnects it: the key is wiped and calls stop coming in. The calls already kept stay, for the line's history. */
export async function disconnectTelephony(): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const existing = await db.telephonyConnection.findUnique({ where: { provider: "CALLERDESK" }, select: { id: true, active: true } });
  if (!existing?.active) return { ok: false, error: "It isn't connected." };
  const retired = await digestSecret(newToken());
  await db.$transaction(async (tx) => {
    await tx.telephonyAgent.deleteMany({ where: { connectionId: existing.id } });
    // A new address on reconnecting, so an old one left in CallerDesk can't be used.
    await tx.telephonyConnection.update({ where: { id: existing.id }, data: { active: false, authCodeEnc: "", webhookTokenHash: retired, webhookTokenEnc: "" } });
  });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "TelephonyConnection", entityId: "CALLERDESK", entityLabel: "CallerDesk disconnected from cloud calling — its key wiped" });
  revalidatePath("/settings/telephony");
  return { ok: true, data: null };
}

/** A new webhook address — the old one stops working at once. */
export async function newWebhookAddress(): Promise<ActionResult<{ url: string }>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const connection = await activeConnection();
  if (!connection) return { ok: false, error: "Connect CallerDesk first." };
  const token = newToken();
  await db.telephonyConnection.update({ where: { id: connection.id }, data: { webhookTokenHash: await digestSecret(token), webhookTokenEnc: await encryptSecret(token) } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TelephonyConnection", entityId: "CALLERDESK", entityLabel: "CallerDesk webhook address changed — the old one no longer works" });
  revalidatePath("/settings/telephony");
  return { ok: true, data: { url: await webhookAddress(token) } };
}

/** The account's members, read from CallerDesk now — for matching to the team. */
export async function telephonyMembers(): Promise<ActionResult<TelephonyMember[]>> {
  const { error } = await settingsUser();
  if (error) return { ok: false, error };
  const connection = await activeConnection();
  const key = connection ? await connectionKey(connection.id) : null;
  if (!connection || !key) return { ok: false, error: "Connect CallerDesk first." };
  try {
    return { ok: true, data: await callerdesk.members(key) };
  } catch (err) {
    return { ok: false, error: `CallerDesk didn't list its members (${failure(err)}).` };
  }
}

/** Which CallerDesk member a person is — or nobody (`memberId` empty). Read back from CallerDesk, so the number is its own. */
export async function saveTelephonyAgent(input: { userId: string; memberId: string }): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const connection = await activeConnection();
  const key = connection ? await connectionKey(connection.id) : null;
  if (!connection || !key) return { ok: false, error: "Connect CallerDesk first." };
  const person = await db.user.findFirst({ where: { id: input.userId, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } });
  if (!person) return { ok: false, error: "That person isn't on the team any more." };

  if (!input.memberId) {
    await db.telephonyAgent.deleteMany({ where: { connectionId: connection.id, userId: person.id } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TelephonyConnection", entityId: "CALLERDESK", entityLabel: `${person.name} is no longer a CallerDesk member here` });
    revalidatePath("/settings/telephony");
    return { ok: true, data: null };
  }
  let member: TelephonyMember | undefined;
  try {
    member = (await callerdesk.members(key)).find((m) => m.memberId === input.memberId);
  } catch (err) {
    return { ok: false, error: `CallerDesk didn't list its members (${failure(err)}).` };
  }
  if (!member) return { ok: false, error: "That member isn't on the CallerDesk account any more." };
  const numberKey = phoneKey(member.number);
  if (!numberKey) return { ok: false, error: `CallerDesk has no usable number for ${member.name}.` };
  const taken = await db.telephonyAgent.findFirst({ where: { connectionId: connection.id, memberId: member.memberId, userId: { not: person.id } }, select: { user: { select: { name: true } } } });
  if (taken) return { ok: false, error: `${member.name} is already ${taken.user.name} here.` };

  await db.telephonyAgent.upsert({
    where: { connectionId_userId: { connectionId: connection.id, userId: person.id } },
    create: { connectionId: connection.id, userId: person.id, memberId: member.memberId, memberName: member.name, memberNumber: member.number, numberKey },
    update: { memberId: member.memberId, memberName: member.name, memberNumber: member.number, numberKey },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TelephonyConnection", entityId: "CALLERDESK", entityLabel: `${person.name} is CallerDesk member ${member.name} (${member.number})` });
  revalidatePath("/settings/telephony");
  return { ok: true, data: null };
}

/** Who missed calls go to when nobody took them and the company has no owner — or nobody. */
export async function saveMissedCallsPerson(userId: string | null): Promise<ActionResult<null>> {
  const { user, error } = await settingsUser();
  if (error) return { ok: false, error };
  const connection = await activeConnection();
  if (!connection) return { ok: false, error: "Connect CallerDesk first." };
  const person = userId ? await db.user.findFirst({ where: { id: userId, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } }) : null;
  if (userId && !person) return { ok: false, error: "That person isn't on the team any more." };
  await db.telephonyConnection.update({ where: { id: connection.id }, data: { missedCallsUserId: person?.id ?? null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TelephonyConnection", entityId: "CALLERDESK", entityLabel: person ? `Missed calls nobody else owns go to ${person.name}` : "Missed calls nobody owns stay on the business line's list" });
  revalidatePath("/settings/telephony");
  return { ok: true, data: null };
}

/** Reads CallerDesk's call list now, rather than on the next beat. */
export async function syncTelephonyNow(): Promise<ActionResult<{ calls: number; logged: number; done: boolean; note: string | null }>> {
  const { error } = await settingsUser();
  if (error) return { ok: false, error };
  const connection = await activeConnection();
  if (!connection) return { ok: false, error: "Connect CallerDesk first." };
  const result = await syncConnection(connection.id, { budgetMs: 25_000 });
  revalidatePath("/settings/telephony");
  revalidatePath("/calls");
  if (result.error) return { ok: false, error: `CallerDesk: ${result.error}` };
  return { ok: true, data: { calls: result.calls, logged: result.logged, done: result.done, note: result.note } };
}

/** How long after a read another can be asked for from the Calls pages — the heartbeat reads every five minutes anyway. */
const READ_AGAIN_AFTER_MS = 60_000;

/** When the calls were last read from the provider — for the Calls pages' button. Null without a connection. */
export async function callsLastRead(): Promise<{ at: Date | null } | null> {
  await requireModuleAccess("calls");
  const connection = await activeConnection();
  if (!connection) return null;
  const row = await db.telephonyConnection.findUnique({ where: { id: connection.id }, select: { lastSyncAt: true } });
  return { at: row?.lastSyncAt ?? null };
}

/**
 * "Read calls now" on the Calls pages (owner, 31 Oct 2026): anyone who works calls may ask for the provider's calls
 * without waiting for the next five-minute read — it only reads what CallerDesk already has, as the heartbeat does.
 * Once a minute at most, whoever asks; never while viewing as somebody else.
 */
export async function readCallsNow(): Promise<ActionResult<{ calls: number; logged: number; done: boolean; note: string | null }>> {
  await requireModuleAccess("calls");
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const connection = await activeConnection();
  if (!connection) return { ok: false, error: "CallerDesk isn't connected — whoever manages settings can connect it in Settings › Cloud calling." };
  const row = await db.telephonyConnection.findUnique({ where: { id: connection.id }, select: { lastSyncAt: true } });
  const since = row?.lastSyncAt ? Date.now() - row.lastSyncAt.getTime() : Infinity;
  const seconds = Math.max(1, Math.round(since / 1000));
  if (since < READ_AGAIN_AFTER_MS) return { ok: false, error: `Calls were read ${seconds} second${seconds === 1 ? "" : "s"} ago — try again in a minute.` };
  const result = await syncConnection(connection.id, { budgetMs: 25_000 });
  revalidatePath("/calls");
  revalidatePath("/calls/line");
  if (result.error) return { ok: false, error: `CallerDesk: ${result.error}` };
  return { ok: true, data: { calls: result.calls, logged: result.logged, done: result.done, note: result.note } };
}

// ─── A call dialog ──────────────────────────────────────────────────────────────────────────

/** The business line this person can call through — connected, and they're a member on it — or null. */
export async function myLine(): Promise<{ name: string; deskphone: string } | null> {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls")) || (await viewAsContext())) return null;
  const connection = await activeConnection();
  if (!connection) return null;
  const agent = await db.telephonyAgent.findUnique({ where: { connectionId_userId: { connectionId: connection.id, userId: user.id } }, select: { id: true } });
  // Calls and recordings only: no business number, so nothing to call through.
  return agent && connection.deskphone ? { name: PROVIDER_NAMES[connection.provider], deskphone: connection.deskphone } : null;
}

/**
 * "Call through CallerDesk": CallerDesk rings the caller's own phone, then the customer, from the business's
 * number. The call comes back in its report and is logged with what the dialog was about.
 */
export async function callThroughLine(input: {
  companyId: string;
  contactId?: string;
  phoneNumber: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };
  if (await viewAsContext()) return { ok: false, error: "You're viewing Deskzo as somebody else — calls aren't placed as them." };
  // A masked number is the contact's own, looked up here (src/lib/contacts/masking.ts) — never sent to the browser.
  const phoneNumber = (await dialledNumber(user.id, input)).number;
  if (!hasDialableNumber(phoneNumber)) return { ok: false, error: "That number can't be dialled." };
  const connection = await activeConnection();
  const key = connection ? await connectionKey(connection.id) : null;
  if (!connection || !key) return { ok: false, error: "Cloud calling isn't connected." };
  if (!connection.deskphone) return { ok: false, error: "CallerDesk is connected for calls and recordings only — calls aren't placed through it." };
  const agent = await db.telephonyAgent.findUnique({ where: { connectionId_userId: { connectionId: connection.id, userId: user.id } }, select: { memberId: true } });
  if (!agent) return { ok: false, error: "You aren't a CallerDesk member here — ask whoever manages settings to match you in Settings › Cloud calling." };

  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true, managedByResellerId: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "That company no longer exists." };
  if (company.managedByResellerId) return { ok: false, error: "This customer is looked after by a reseller — they're not called directly from here." };
  const belongs = (found: { companyId: string } | null) => !!found && found.companyId === company.id;
  if (input.contactId && !belongs(await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true } }))) return { ok: false, error: "That contact doesn't belong to this company." };
  if (input.leadId && !belongs(await db.lead.findUnique({ where: { id: input.leadId }, select: { companyId: true } }))) return { ok: false, error: "That lead isn't this company's." };
  if (input.ticketId && !belongs(await db.ticket.findUnique({ where: { id: input.ticketId }, select: { companyId: true } }))) return { ok: false, error: "That ticket isn't this company's." };
  if (input.companyProductId && !belongs(await db.companyProduct.findUnique({ where: { id: input.companyProductId }, select: { companyId: true } }))) {
    return { ok: false, error: "That order isn't this company's." };
  }

  let campaignId: string | null;
  try {
    campaignId = (await callerdesk.clickToCall(key, { memberId: agent.memberId, customerNumber: phoneNumber, deskphone: connection.deskphone })).campaignId;
  } catch (err) {
    return { ok: false, error: `CallerDesk didn't place the call (${failure(err)}).` };
  }
  const call = await db.telephonyCall.create({
    data: {
      connectionId: connection.id,
      campaignId,
      state: "REQUESTED",
      direction: "OUTBOUND",
      customerNumber: phoneNumber,
      customerKey: phoneKey(phoneNumber),
      virtualNumber: connection.deskphone,
      agentUserId: user.id,
      requestedByUserId: user.id,
      startedAt: new Date(),
      companyId: company.id,
      contactId: input.contactId || null,
      leadId: input.leadId || null,
      ticketId: input.ticketId || null,
      companyProductId: input.companyProductId || null,
    },
    select: { id: true },
  });
  return { ok: true, data: call };
}

/** How a call placed from a dialog is getting on — the caller's own only. */
export async function lineCallState(id: string): Promise<{ state: TelephonyCallState; logged: boolean; callLogId: string | null; outcome: string | null } | null> {
  const user = await requireModuleUser("calls");
  const call = await db.telephonyCall.findFirst({ where: { id, requestedByUserId: user.id }, select: { state: true, callLogId: true, outcome: true } });
  return call ? { state: call.state, logged: !!call.callLogId, callLogId: call.callLogId, outcome: call.outcome } : null;
}

const reviewSchema = z.object({
  outcome: z.enum(callOutcomeValues as [CallOutcome, ...CallOutcome[]]),
  notes: z.string().trim().max(4000).default(""),
  /** A `datetime-local` value, in the workspace's time; empty for none. */
  followUpAt: z.string().trim().max(40).default(""),
});

/**
 * How a call through the business line went — what was said, and a callback if one was promised — for the
 * person's own, within a fortnight. Like the Deskzo app's after-call card (src/lib/app/calls.ts): the call
 * logged itself with its length; this is the word on it.
 */
export async function reviewCloudCall(callLogId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) return { ok: false, error: NOT_CALLS };
  if (await viewAsContext()) return { ok: false, error: "You're viewing Deskzo as somebody else — their calls aren't yours to write up." };
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check how it went." };
  const call = await db.callLog.findFirst({
    where: { id: callLogId, userId: user.id, source: "CLOUD", startedAt: { gte: new Date(Date.now() - REVIEW_DAYS * 86_400_000) } },
    select: { id: true, companyId: true, leadId: true, startedAt: true, phoneNumber: true, followUpTaskId: true, company: { select: { name: true } }, contact: { select: { name: true } } },
  });
  if (!call) return { ok: false, error: "That isn't one of your calls through the business line from the last fortnight." };
  const d = parsed.data;
  const clock = await workspaceClock();
  const followUpAt = d.followUpAt ? clock.parseInput(d.followUpAt) : null;
  if (d.followUpAt && !followUpAt) return { ok: false, error: "That callback time isn't a date." };
  if (d.outcome === "CALLBACK_REQUESTED" && !followUpAt) return { ok: false, error: "They asked to be called back — say when." };
  const notes = d.notes || null;
  const name = call.contact?.name ?? call.company.name;

  await db.$transaction(async (tx) => {
    await tx.callLog.update({ where: { id: call.id }, data: { outcome: d.outcome, notes, reviewedAt: new Date(), ...(followUpAt ? { followUpAt, followUpDone: false } : {}) } });
    if (followUpAt && call.followUpTaskId) {
      await tx.task.update({ where: { id: call.followUpTaskId }, data: { dueDate: followUpAt, done: false, doneAt: null } });
    } else if (followUpAt) {
      const task = await tx.task.create({
        data: {
          title: `Call back ${name}${call.contact ? ` at ${call.company.name}` : ""}`,
          description: notes ? `Promised on the call: ${notes}` : `Promised during a call to ${call.phoneNumber}.`,
          dueDate: followUpAt,
          assignedToUserId: user.id,
          createdByUserId: user.id,
          companyId: call.companyId,
          leadId: call.leadId,
        },
        select: { id: true },
      });
      await tx.callLog.update({ where: { id: call.id }, data: { followUpTaskId: task.id } });
    }
  });
  // The lead's timeline: the entry made when the call was logged, now with how it went.
  if (call.leadId) {
    const text = `${callOutcomeLabels[d.outcome].toLowerCase()}${notes ? ` — ${notes}` : ""}`;
    const updated = await db.activity.updateMany({ where: { leadId: call.leadId, userId: user.id, type: "CALL", occurredAt: call.startedAt }, data: { notes: text } });
    if (updated.count === 0) await db.activity.create({ data: { leadId: call.leadId, userId: user.id, type: "CALL", notes: text, occurredAt: call.startedAt } }).catch(() => null);
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CallLog", entityId: call.id, entityLabel: `Call with ${call.company.name} — ${callOutcomeLabels[d.outcome].toLowerCase()}` });
  revalidatePath("/calls");
  revalidatePath(`/companies/${call.companyId}`);
  if (followUpAt) revalidatePath("/tasks");
  return { ok: true, data: null };
}

// ─── Calls › Business line ──────────────────────────────────────────────────────────────────

const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type LineReportView = LineReport & { from: string; to: string; today: string; connected: boolean; everyone: boolean; clamped: boolean; mayMakeLeads: boolean };

export async function businessLineReport(params: { from?: string; to?: string }): Promise<LineReportView | null> {
  const user = await requireModuleAccess("calls");
  if (!(await isModuleEnabled("calls"))) return null;
  const clock = await workspaceClock();
  const today = clock.today();
  let to = params.to && DAY.test(params.to) ? params.to : today;
  let from = params.from && DAY.test(params.from) ? params.from : shift(to, -6);
  if (from > to) [from, to] = [to, from];
  const clamped = shift(from, REPORT_MAX_DAYS - 1) < to;
  if (clamped) from = shift(to, -(REPORT_MAX_DAYS - 1));
  const range = clock.dayRange(from, to)!;

  let connectionId: string | null = null;
  try {
    connectionId = (await db.telephonyConnection.findFirst({ orderBy: [{ active: "desc" }, { connectedAt: "asc" }], select: { id: true } }))?.id ?? null;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const reached = await peopleReached(user.id, "activities", "view");
  // A number on nobody can become a lead, for whoever may open leads (src/app/(dashboard)/leads/new).
  const mayMakeLeads = (await moduleAccessFor(user.id, "leads")) === "available" && (await can(user.id, "leads.view")) && (await can(user.id, "leads.create"));
  const empty = buildLineReport({ clock, calls: [], later: [], names: new Map() });
  if (!connectionId) return { ...empty, from, to, today, connected: false, everyone: reached === null, clamped, mayMakeLeads };

  // Somebody who sees everybody's calls sees the whole line; anybody else, the calls of the people they reach.
  const whose = reached === null ? {} : { OR: [{ agentUserId: { in: reached } }, { requestedByUserId: { in: reached } }] };
  const rows = await db.telephonyCall.findMany({
    where: { AND: [{ connectionId, confirmedAt: { not: null }, state: "ENDED", startedAt: range }, whose] },
    orderBy: { startedAt: "asc" },
    take: 20_000,
    select: { id: true, direction: true, outcome: true, startedAt: true, talkSeconds: true, ringSeconds: true, customerKey: true, customerNumber: true, virtualNumber: true, agentUserId: true, agentName: true, callLogId: true },
  });

  // A missed call answered after the period: calls out to the number in the week after, from the line or logged any other way.
  const missedKeys = [...new Set(rows.filter((r) => r.direction === "INBOUND" && r.outcome !== "CONNECTED" && r.customerKey).map((r) => r.customerKey!))];
  const after = { gte: range.lt ?? new Date(), lt: new Date((range.lt ?? new Date()).getTime() + 7 * 86_400_000) };
  const later: LaterCall[] = [];
  if (missedKeys.length) {
    const [lineLater, logged] = await Promise.all([
      db.telephonyCall.findMany({ where: { connectionId, customerKey: { in: missedKeys }, startedAt: after, OR: [{ direction: "OUTBOUND" }, { outcome: "CONNECTED" }] }, select: { customerKey: true, startedAt: true } }),
      db.callLog.findMany({ where: { direction: "OUTBOUND", source: { not: "CLOUD" }, startedAt: { gte: range.gte, lt: after.lt } }, select: { phoneNumber: true, startedAt: true }, take: 20_000 }),
    ]);
    const wanted = new Set(missedKeys);
    for (const c of lineLater) later.push({ key: c.customerKey!, at: c.startedAt });
    for (const c of logged) {
      const key = phoneKey(c.phoneNumber);
      if (key && wanted.has(key)) later.push({ key, at: c.startedAt });
    }
  }
  const agentIds = [...new Set(rows.map((r) => r.agentUserId).filter((id): id is string => !!id))];
  const names = new Map((agentIds.length ? await db.user.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const report = buildLineReport({
    clock,
    calls: rows.map((r) => ({ ...r, logged: !!r.callLogId })),
    later,
    names,
  });
  return { ...report, from, to, today, connected: true, everyone: reached === null, clamped, mayMakeLeads };
}
