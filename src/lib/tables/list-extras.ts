import { db } from "@/lib/db";
import { getTablePreferences } from "@/actions/table-preference";
import { resolveColumns } from "@/lib/tables/registry";
import { renewalManagersOf } from "@/lib/companies/renewal-manager";
import { vendorInvoicesOf } from "@/lib/orders/vendor-invoice";
import { notMigratedYet } from "@/lib/not-migrated";
import { historyOfCompanies } from "@/lib/customers/stats";
import { HISTORY_COLUMNS } from "@/lib/customers/history-columns";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * What a list's optional columns need beyond its own query (owner, 30 Oct 2026 — account manager, caller, last
 * activity, next follow-up…). Each reads for the rows of one page at once, a query or two whatever the page size, and
 * a page asks only for what this person shows.
 */

/** The columns this person shows on a table, as the picker resolves them. */
export async function shownColumns(tableKey: string): Promise<Set<string>> {
  const prefs = await getTablePreferences();
  return new Set(resolveColumns(tableKey, prefs[tableKey] ?? null));
}

const latest = (into: Map<string, Date>, id: string | null | undefined, at: Date | null | undefined) => {
  if (!id || !at) return;
  const was = into.get(id);
  if (!was || was < at) into.set(id, at);
};

/** Each company's last call, note or email: its calls, the activity on its leads, the business emails sent to it. */
export async function lastActivityOfCompanies(companyIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return out;
  const [calls, notes, emails] = await Promise.all([
    db.callLog.groupBy({ by: ["companyId"], where: { companyId: { in: ids } }, _max: { startedAt: true } }),
    db.lead.findMany({
      where: { companyId: { in: ids }, activities: { some: {} } },
      select: { companyId: true, activities: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true } } },
    }),
    db.marketingMessage.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, messageClass: "TRANSACTIONAL", status: "SENT" }, _max: { sentAt: true } }),
  ]);
  for (const c of calls) latest(out, c.companyId, c._max.startedAt);
  for (const l of notes) latest(out, l.companyId, l.activities[0]?.occurredAt);
  for (const e of emails) latest(out, e.companyId, e._max.sentAt);
  return out;
}

/** What a company uses that it didn't buy from us, for the list's two columns: its products, and the soonest renewal. */
export type ElsewhereSummary = { products: string[]; next: { product: string; on: string } | null };

/**
 * Each company's installed-elsewhere entries (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts), summed up for a list:
 * the products by soonest renewal, "Sophos XGS from Redington", and the next renewal still to come. Read for the rows
 * already in reach, so nothing here widens who sees what; nothing in a workspace not migrated yet.
 */
export async function elsewhereOfCompanies(companyIds: string[]): Promise<Map<string, ElsewhereSummary>> {
  const out = new Map<string, ElsewhereSummary>();
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return out;
  try {
    const today = (await workspaceClock()).calendarDate(new Date());
    const rows = await db.installedElsewhere.findMany({
      where: { companyId: { in: ids } },
      orderBy: [{ renewsOn: { sort: "asc", nulls: "last" } }, { productName: "asc" }],
      select: { companyId: true, productName: true, boughtFrom: true, quantity: true, renewsOn: true },
    });
    for (const r of rows) {
      const s = out.get(r.companyId) ?? { products: [], next: null };
      s.products.push(`${r.productName}${r.quantity ? ` ×${r.quantity}` : ""}${r.boughtFrom ? ` from ${r.boughtFrom}` : ""}`);
      if (!s.next && r.renewsOn && r.renewsOn >= today) s.next = { product: r.productName, on: r.renewsOn.toISOString().slice(0, 10) };
      out.set(r.companyId, s);
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/** Each lead's last call or note. */
export async function lastActivityOfLeads(leadIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return out;
  const [notes, calls] = await Promise.all([
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: ids } }, _max: { occurredAt: true } }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: ids } }, _max: { startedAt: true } }),
  ]);
  for (const n of notes) latest(out, n.leadId, n._max.occurredAt);
  for (const c of calls) latest(out, c.leadId, c._max.startedAt);
  return out;
}

/** Each lead's next follow-up: its earliest open task with a due date, or its next meeting not called off. */
export async function nextFollowUpOfLeads(leadIds: string[], now: Date = new Date()): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ids = [...new Set(leadIds)];
  if (ids.length === 0) return out;
  const soonest = (id: string | null, at: Date | null) => {
    if (!id || !at) return;
    const was = out.get(id);
    if (!was || at < was) out.set(id, at);
  };
  const [tasks, meetings] = await Promise.all([
    db.task.groupBy({ by: ["leadId"], where: { leadId: { in: ids }, done: false, status: { notIn: ["DONE", "CANCELLED"] }, dueDate: { not: null } }, _min: { dueDate: true } }),
    db.calendarEvent.groupBy({ by: ["leadId"], where: { leadId: { in: ids }, status: { not: "CANCELLED" }, startsAt: { gte: now } }, _min: { startsAt: true } }),
  ]);
  for (const t of tasks) soonest(t.leadId, t._min.dueDate);
  for (const m of meetings) soonest(m.leadId, m._min.startsAt);
  return out;
}

/**
 * A company list's page with what its optional columns need beyond the list's own query: the renewal manager (a column
 * not every workspace has yet) and the last activity — each read only when this person shows it, undefined otherwise.
 */
export async function withCompanyExtras<T extends { id: string; owner: { id: string; name: string } | null }>(tableKey: string, rows: T[]) {
  const shown = await shownColumns(tableKey);
  const [managers, last, history, elsewhere] = await Promise.all([
    shown.has("renewalManager") ? renewalManagersOf(rows) : null,
    shown.has("lastActivity") ? lastActivityOfCompanies(rows.map((r) => r.id)) : null,
    // Its history with us (owner, 31 Oct 2026): the stored row, one query for the page, null where the table isn't there.
    HISTORY_COLUMNS.some((k) => shown.has(k)) ? historyOfCompanies(rows.map((r) => r.id)) : undefined,
    shown.has("elsewhere") || shown.has("elsewhereRenewal") ? elsewhereOfCompanies(rows.map((r) => r.id)) : null,
  ]);
  return rows.map((r) => ({
    ...r,
    renewalManager: managers ? (managers.get(r.id) ?? null) : undefined,
    lastActivityAt: last ? (last.get(r.id)?.toISOString() ?? null) : undefined,
    history: history === undefined ? undefined : history ? (history.get(r.id) ?? null) : null,
    elsewhere: elsewhere ? (elsewhere.get(r.id) ?? null) : undefined,
  }));
}

/**
 * The leads list's page with what its optional columns need beyond the list's query: the last activity, the next
 * follow-up and when it last moved stage (a column not every workspace has yet) — each only when shown.
 */
export async function withLeadExtras<T extends { id: string }>(rows: T[]) {
  const shown = await shownColumns("leads");
  const ids = rows.map((r) => r.id);
  const now = Date.now();
  const [last, next, moved] = await Promise.all([
    shown.has("lastActivity") ? lastActivityOfLeads(ids) : null,
    shown.has("nextFollowUp") ? nextFollowUpOfLeads(ids) : null,
    shown.has("daysInStage") ? stageChangesOf(ids) : null,
  ]);
  return rows.map((r) => ({
    ...r,
    lastActivityAt: last ? (last.get(r.id)?.toISOString() ?? null) : undefined,
    nextFollowUpAt: next ? (next.get(r.id)?.toISOString() ?? null) : undefined,
    daysInStage: moved ? (moved.has(r.id) ? Math.max(0, Math.floor((now - moved.get(r.id)!.getTime()) / 86_400_000)) : null) : undefined,
  }));
}

/** When each lead last moved stage — read by name, nothing in a workspace not migrated yet. */
async function stageChangesOf(leadIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (leadIds.length === 0) return out;
  try {
    for (const l of await db.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, stageChangedAt: true, createdAt: true } })) out.set(l.id, l.stageChangedAt ?? l.createdAt);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/** An order list's page with each customer's renewal manager, when that column is shown. */
export async function withOrderExtras<T extends { id: string; company: { id: string; owner?: { id: string; name: string } | null } }>(rows: T[]) {
  const shown = await shownColumns("orders");
  const [managers, invoices] = await Promise.all([
    shown.has("renewalManager") ? renewalManagersOf(rows.map((r) => ({ id: r.company.id, owner: r.company.owner ?? null }))) : null,
    // The vendor's invoice number (owner, 16 Nov 2026 — src/lib/orders/vendor-invoice.ts).
    shown.has("vendorInvoice") ? vendorInvoicesOf(rows.map((r) => r.id)) : null,
  ]);
  if (!managers && !invoices) return rows;
  return rows.map((r) => ({
    ...r,
    ...(managers ? { renewalManager: managers.get(r.company.id) ?? null } : {}),
    ...(invoices ? { vendorInvoice: invoices.get(r.id) ?? null } : {}),
  }));
}

/** Each subscription's last call or renewal reminder about it. */
export async function lastContactOfRenewals(ids: string[]): Promise<Map<string, Date>> {
  const last = new Map<string, Date>();
  if (ids.length === 0) return last;
  const [calls, notices] = await Promise.all([
    db.callLog.groupBy({ by: ["companyProductId"], where: { companyProductId: { in: ids } }, _max: { startedAt: true } }),
    db.marketingMessage.groupBy({ by: ["companyProductId"], where: { companyProductId: { in: ids }, status: "SENT" }, _max: { sentAt: true } }),
  ]);
  for (const c of calls) latest(last, c.companyProductId, c._max.startedAt);
  for (const n of notices) latest(last, n.companyProductId, n._max.sentAt);
  return last;
}

/** A renewals page with each subscription's last call or renewal reminder about it, when that column is shown. */
export async function withRenewalExtras<T extends { id: string }>(rows: T[]) {
  if (rows.length === 0 || !(await shownColumns("renewals")).has("lastContacted")) return rows;
  const last = await lastContactOfRenewals(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, lastContactedAt: last.get(r.id)?.toISOString() ?? null }));
}
