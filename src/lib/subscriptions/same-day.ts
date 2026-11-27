import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import type { MergeValues } from "@/lib/marketing/merge";

/**
 * A customer's subscriptions renewing on the same day, told in one email (owner, 3 Nov 2026: "if 3 different
 * subscriptions like Microsoft 365 Business Basic, Business Standard, Business Premium have same subscription date so
 * only one mail cover all three"). Used by a workflow's template email (src/lib/automate/actions/email-send.ts) and by
 * the customer renewal reminders (src/lib/renewal-customer-reminders.ts): the template's {{productName}} names them
 * all, {{quantity}} and {{renewalValue}} add them up, and {{subscriptions}} draws a row for each.
 */

export type SameDaySubscription = { id: string; orderSeq: number; itemName: string; quantity: number; renewalValue: number; endDate: Date | null };

/** In a template: the table of the subscriptions it's about, put in after the fields are filled (it isn't escaped). */
export const SUBSCRIPTIONS_TOKEN = /\{\{\s*subscriptions\s*(?:\|[^}]*)?\}\}/g;
const MARK = "%%DESKZO_SUBSCRIPTIONS%%";

/**
 * The customer's subscriptions ending the day `primaryId` does — itself first, then the rest in order — that are up for
 * renewal (a top-level subscription, not cancelled or refused) and, given `where`, match it too. Just the one when it
 * has no end date.
 */
export async function sameDaySubscriptions(primaryId: string, where: Prisma.CompanyProductWhereInput = {}): Promise<SameDaySubscription[]> {
  const primary = await db.companyProduct.findUnique({ where: { id: primaryId }, select: { companyId: true, endDate: true } });
  if (!primary) return [];
  const rows = await db.companyProduct.findMany({
    where: primary.endDate
      ? { OR: [{ id: primaryId }, { AND: [{ companyId: primary.companyId, endDate: primary.endDate, parentId: null, item: { type: "SUBSCRIPTION" }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } }, where] }] }
      : { id: primaryId },
    orderBy: { orderSeq: "asc" },
    take: 50,
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      unitPrice: true,
      fullTermUnitPrice: true,
      startDate: true,
      endDate: true,
      item: { select: { name: true } },
      addons: { where: { orderStatus: { not: "CANCELLED" } }, select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true } },
    },
  });
  const num = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));
  const subs = rows.map((r) => {
    // With its add-ons, as the single renewal reminder counts it — "20 seats", not "10 and separately 10".
    const group = renewalGroup([
      { id: r.id, quantity: r.quantity, unitPrice: num(r.unitPrice), fullTermUnitPrice: num(r.fullTermUnitPrice), startDate: r.startDate, isAddon: false },
      ...r.addons.map((a) => ({ id: a.id, quantity: a.quantity, unitPrice: num(a.unitPrice), fullTermUnitPrice: num(a.fullTermUnitPrice), startDate: a.startDate, isAddon: true })),
    ]);
    return { id: r.id, orderSeq: r.orderSeq, itemName: r.item.name, quantity: group.totalQuantity, renewalValue: group.renewalValue, endDate: r.endDate };
  });
  return [...subs.filter((s) => s.id === primaryId), ...subs.filter((s) => s.id !== primaryId)];
}

/** "A", "A and B", "A, B and C". */
function listed(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The fields several subscriptions fill: every name, the seats and the value added up, how many there are. */
export function sameDayValues(subs: SameDaySubscription[]): MergeValues {
  const value = subs.reduce((t, s) => t + s.renewalValue, 0);
  return {
    productName: listed(subs.map((s) => s.itemName)),
    quantity: subs.reduce((t, s) => t + s.quantity, 0),
    renewalValue: value > 0 ? formatCurrency(value) : null,
    subscriptionCount: subs.length,
    orderId: subs.map((s) => formatOrderId(s.orderSeq)).join(", "),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The table {{subscriptions}} becomes: a row for each — product, seats, renews on. No prices (owner, 13 Nov 2026: "i
 * don't want pricing thing to send"): a renewal email says what renews and when; the amount comes with the quote or
 * invoice. A template that wants a figure can still ask for {{renewalValue}} itself.
 */
export function subscriptionsTable(subs: SameDaySubscription[], format: "HTML" | "TEXT"): string {
  if (format === "TEXT") {
    return subs.map((s) => `· ${s.itemName} — ${s.quantity} — renews ${s.endDate ? formatCalendarDay(s.endDate) : "—"}`).join("\n");
  }
  const cell = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font:14px Arial,sans-serif;color:#0f172a";
  const head = "padding:6px 10px;border-bottom:2px solid #cbd5e1;font:600 13px Arial,sans-serif;color:#475569;text-align:left";
  const rows = subs
    .map((s) => `<tr><td style="${cell}">${esc(s.itemName)}</td><td style="${cell};text-align:right">${s.quantity}</td><td style="${cell}">${s.endDate ? esc(formatCalendarDay(s.endDate)) : "—"}</td></tr>`)
    .join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:12px 0"><thead><tr><th style="${head}">Product</th><th style="${head};text-align:right">Seats</th><th style="${head}">Renews on</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** A template with {{subscriptions}} marked, so the merge leaves it alone; `fill` puts the table in afterwards. */
export function markSubscriptions(template: string): string {
  return template.replace(SUBSCRIPTIONS_TOKEN, MARK);
}

export function fillSubscriptions(rendered: string, table: string): string {
  return rendered.split(MARK).join(table);
}
