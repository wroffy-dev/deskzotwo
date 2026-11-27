"use server";

import type { Prisma, UnmaskResult } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { logActivity } from "@/lib/activity";
import { notMigratedYet } from "@/lib/not-migrated";
import { pageSlice } from "@/lib/pagination";
import { csvRow } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { parseRecordRef } from "@/lib/record-url";
import type { ActionResult } from "@/actions/company";
import { formatLeadId } from "@/lib/order-id";
import { recordAudit } from "@/lib/audit";
import { MAX_DAILY_UNMASK_LIMIT, UNMASK_SETTINGS_ID, verifyUnmaskChain, workspaceUnmaskDefault } from "@/lib/authz/unmask";

/**
 * The Unmasking logs (src/lib/authz/unmask.ts): every attempt to unmask a lead or a contact, allowed or refused,
 * for the workspace's super admin and nobody else.
 *
 * "Super admin" is the account flag the database keeps to exactly one (`users.isSuperAdmin`), read
 * from the database on every call — not a role name, and not the session's own say. Viewing as
 * somebody never opens it: the request is then acting as them, and nobody else is a super admin.
 * Platform support, on either grant, is not a super admin either.
 *
 * The log holds which fields, never what they held; nothing here could show a value if it wanted to.
 * Nothing here changes a row, and the table itself refuses to (a trigger), so the log reads the same
 * to everyone who may read it, for as long as it is kept.
 *
 * Owner, 5 Nov 2026 — Phase 3 masking fixes (audit H.4.5, H.4.8, M-10): each row says what was revealed (a lead or a
 * contact, by entity and id) and the reason the person gave, and the log is a hash chain the page checks
 * (`unmaskLogIntegrity`). The workspace's default daily limit is set here too (`setUnmaskDefaultLimit`) — a file
 * that is already the super admin's and core, beside the master switch it is drawn with.
 */

export type UnmaskLogFilters = {
  /** YYYY-MM-DD, both ends included, on the workspace's clock. */
  from?: string;
  to?: string;
  userId?: string;
  /** A lead's number ("LEAD-000123") or id. */
  lead?: string;
  result?: string;
};

const RESULTS: readonly UnmaskResult[] = ["ALLOWED", "REPEAT", "QUOTA_EXHAUSTED", "DENIED"];
const EXPORT_CAP = 10_000;

/** Whether the person asking may read the log: the super admin, as themselves. */
export async function mayReadUnmaskLog(): Promise<boolean> {
  const user = await requireUser();
  return actingAsSuperAdmin(user.id);
}

async function whereFor(filters: UnmaskLogFilters): Promise<Prisma.UnmaskEventWhereInput> {
  const clock = await workspaceClock();
  const range = clock.dayRange(filters.from || null, filters.to || null);
  const and: Prisma.UnmaskEventWhereInput[] = [];
  if (range) and.push({ at: range });
  if (filters.userId) and.push({ userId: String(filters.userId).slice(0, 64) });
  if (filters.result && (RESULTS as readonly string[]).includes(filters.result)) and.push({ result: filters.result as UnmaskResult });
  const lead = filters.lead?.trim();
  if (lead) {
    const ref = parseRecordRef(lead);
    // A number however it was typed — LEAD-123, 123 — is the one the log froze, LEAD-000123.
    and.push(ref.kind === "seq" ? { leadRef: formatLeadId(ref.seq) } : { leadId: lead.slice(0, 64) });
  }
  return and.length ? { AND: and } : {};
}

export type UnmaskLogRow = {
  id: string;
  at: string;
  businessDate: string;
  userId: string;
  userName: string;
  impersonatedBy: string | null;
  leadId: string;
  /** "leads", "contacts" or "companies", and the record's id. */
  entity: string;
  recordId: string;
  leadRef: string | null;
  /**
   * The lead's name and number as they are now, for the super admin reading the log — looked up when
   * the page is drawn, never stored in the log, and null once the lead is gone (or the row is a contact's).
   */
  lead: { title: string; leadSeq: number } | null;
  /** A contact's name and its company's number as they are now, looked up the same way; null for a lead's row. */
  contact: { name: string; companySeq: number } | null;
  /** What the person said they needed it for, when they said. */
  statedReason: string | null;
  /** The row's place in the hash chain. */
  seq: number;
  fields: string[];
  result: UnmaskResult;
  consumed: boolean;
  usedToday: number | null;
  dailyLimit: number | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  tenantId: string | null;
};

export async function listUnmaskEvents(
  filters: UnmaskLogFilters,
  page: { page: number; pageSize: number },
): Promise<ActionResult<{ rows: UnmaskLogRow[]; total: number; people: { id: string; name: string }[] }>> {
  if (!(await mayReadUnmaskLog())) return { ok: false, error: "Only the super admin can read the unmasking logs." };
  try {
    const where = await whereFor(filters ?? {});
    const [rows, total, people] = await Promise.all([
      db.unmaskEvent.findMany({ where, orderBy: { at: "desc" }, ...pageSlice(Math.max(1, page.page), Math.min(200, Math.max(1, page.pageSize))) }),
      db.unmaskEvent.count({ where }),
      // Everybody who appears in the log, for the person filter — by the name the log froze.
      db.unmaskEvent.findMany({ distinct: ["userId"], select: { userId: true, userName: true }, orderBy: { userName: "asc" }, take: 500 }),
    ]);
    const actors = [...new Set(rows.map((r) => r.impersonatedByUserId).filter((id): id is string => Boolean(id)))];
    const idsOf = (entity: string) => [...new Set(rows.filter((r) => r.entity === entity).map((r) => r.recordId))];
    const [actorRows, leadRows, contactRows] = await Promise.all([
      db.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true } }),
      db.lead.findMany({ where: { id: { in: idsOf("leads") } }, select: { id: true, title: true, leadSeq: true } }),
      db.contact.findMany({ where: { id: { in: idsOf("contacts") } }, select: { id: true, name: true, company: { select: { companySeq: true } } } }),
    ]);
    const names = new Map(actorRows.map((u) => [u.id, u.name]));
    const leads = new Map(leadRows.map((l) => [l.id, { title: l.title, leadSeq: l.leadSeq }]));
    const contacts = new Map(contactRows.map((c) => [c.id, { name: c.name, companySeq: c.company.companySeq }]));
    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          businessDate: r.businessDate,
          userId: r.userId,
          userName: r.userName,
          impersonatedBy: r.impersonatedByUserId ? (names.get(r.impersonatedByUserId) ?? r.impersonatedByUserId) : null,
          leadId: r.leadId,
          entity: r.entity,
          recordId: r.recordId,
          leadRef: r.leadRef,
          lead: r.entity === "leads" ? (leads.get(r.recordId) ?? null) : null,
          contact: r.entity === "contacts" ? (contacts.get(r.recordId) ?? null) : null,
          statedReason: r.statedReason,
          seq: r.seq,
          fields: r.fields,
          result: r.result,
          consumed: r.consumed,
          usedToday: r.usedToday,
          dailyLimit: r.dailyLimit,
          reason: r.reason,
          requestId: r.requestId,
          ip: r.ip,
          userAgent: r.userAgent,
          tenantId: r.tenantId,
        })),
        total,
        people: people.map((p) => ({ id: p.userId, name: p.userName })),
      },
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: { rows: [], total: 0, people: [] } };
    throw err;
  }
}

/** The filtered log as CSV, newest first, up to ten thousand rows — and the export itself logged. */
export async function exportUnmaskEventsCsv(filters: UnmaskLogFilters): Promise<ActionResult<{ csv: string; rows: number; capped: boolean }>> {
  const user = await requireUser();
  if (!(await mayReadUnmaskLog())) {
    await logActivity({ kind: "PERMISSION_DENIED", summary: `${user.name} tried to export the unmasking logs` });
    return { ok: false, error: "Only the super admin can export the unmasking logs." };
  }
  const where = await whereFor(filters ?? {});
  const [rows, total] = await Promise.all([db.unmaskEvent.findMany({ where, orderBy: { at: "desc" }, take: EXPORT_CAP }), db.unmaskEvent.count({ where })]);
  const clock = await workspaceClock();
  // The record by entity and id, the reason the person gave, and each row's place and hashes in the chain — so the
  // file can be checked against itself away from the app (owner, 5 Nov 2026 — audit H.4.5, H.4.8).
  const header = [
    "When", "Business day", "Person", "Person id", "Viewing as (by)", "Record type", "Record", "Record id", "Lead id", "Fields", "Result", "Used a unit", "Used today",
    "Daily limit", "Note", "Reason given", "Request id", "IP", "User agent", "Workspace", "Seq", "Previous hash", "Hash",
  ];
  const lines = rows.map((r) =>
    csvRow([
      clock.dateTime(r.at),
      r.businessDate,
      r.userName,
      r.userId,
      r.impersonatedByUserId ?? "",
      r.entity,
      r.leadRef ?? "",
      r.recordId,
      r.leadId,
      r.fields.join(" "),
      r.result,
      r.consumed ? "yes" : "no",
      r.usedToday ?? "",
      r.dailyLimit ?? "",
      r.reason ?? "",
      r.statedReason ?? "",
      r.requestId ?? "",
      r.ip ?? "",
      r.userAgent ?? "",
      r.tenantId ?? "",
      r.seq,
      r.prevHash,
      r.hash,
    ]),
  );
  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} unmasking log rows`,
    metadata: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters ?? {})) as Prisma.InputJsonValue },
  });
  return { ok: true, data: { csv: [csvRow(header), ...lines].join("\n"), rows: rows.length, capped: total > rows.length } };
}

/** Whether the log is as it was written (owner, 5 Nov 2026 — audit H.4.8): "Log intact", or the first row that isn't. */
export type UnmaskLogIntegrity = { intact: boolean; rows: number; broken: { seq: number; atText: string; userName: string; why: string } | null };

export async function unmaskLogIntegrity(): Promise<ActionResult<UnmaskLogIntegrity>> {
  if (!(await mayReadUnmaskLog())) return { ok: false, error: "Only the super admin can read the unmasking logs." };
  const [report, clock] = await Promise.all([verifyUnmaskChain(), workspaceClock()]);
  return {
    ok: true,
    data: { intact: report.intact, rows: report.rows, broken: report.broken ? { seq: report.broken.seq, atText: clock.dateTime(report.broken.at), userName: report.broken.userName, why: report.broken.why } : null },
  };
}

// ─── The workspace's default daily limit ───────────────────────────────────────────────────────────

/** The default as the settings card draws it. */
export type UnmaskDefaultLimitState = { dailyLimit: number | null; stored: boolean; mayChange: boolean; changedAtText: string | null; changedBy: string | null };

export async function unmaskDefaultLimitState(): Promise<UnmaskDefaultLimitState> {
  const user = await requireUser();
  const [current, mayChange, clock] = await Promise.all([workspaceUnmaskDefault(), actingAsSuperAdmin(user.id), workspaceClock()]);
  const by = current.updatedById ? await db.user.findUnique({ where: { id: current.updatedById }, select: { name: true } }) : null;
  return { dailyLimit: current.dailyLimit, stored: current.stored, mayChange, changedAtText: current.updatedAt ? clock.dateTime(current.updatedAt) : null, changedBy: by?.name ?? null };
}

/**
 * Sets the workspace's default daily limit (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-10): what somebody
 * granted unmask gets when neither they nor their role has a limit. `{ limited: true, dailyLimit }` sets a number;
 * `{ limited: false }` is "no limit", which has to be asked for in so many words. The super admin's alone, like the
 * master switch beside it: it reaches every role at once. Audited.
 */
export async function setUnmaskDefaultLimit(value: { limited: boolean; dailyLimit?: unknown }): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the super admin can change the default daily limit." };
  if (!value || typeof value.limited !== "boolean") return { ok: false, error: "A number a day, or no limit?" };
  let next: number | null = null;
  if (value.limited) {
    const raw = value.dailyLimit;
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: "A daily limit is a whole number of leads and contacts, at least 1." };
    if (n > MAX_DAILY_UNMASK_LIMIT) return { ok: false, error: `A daily limit can be at most ${MAX_DAILY_UNMASK_LIMIT.toLocaleString("en-IN")}.` };
    next = n;
  }
  const before = await workspaceUnmaskDefault();
  if (before.stored && before.dailyLimit === next) return { ok: true, data: null };
  try {
    await db.unmaskSettings.upsert({
      where: { id: UNMASK_SETTINGS_ID },
      create: { id: UNMASK_SETTINGS_ID, defaultDailyLimit: next, updatedById: user.id },
      update: { defaultDailyLimit: next, updatedById: user.id },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
    throw err;
  }
  const words = (n: number | null) => (n === null ? "no limit" : `${n} a day`);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "UnmaskSettings",
    entityId: UNMASK_SETTINGS_ID,
    entityLabel: `Default daily unmasking limit: ${words(before.dailyLimit)} → ${words(next)}`,
  });
  revalidatePath("/settings/access", "layout");
  revalidatePath("/settings/users");
  return { ok: true, data: null };
}
