import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Which orders not yet invoiced owe money in their own right (owner, 21 Nov 2026 — "My collections shows ₹182 crore
 * … because of orders coming from my old crm"). My collections and the credit check both count such an order as
 * money owed until an invoice carries it. That holds only for orders billed in Deskzo:
 *
 *  - an order brought from the old CRM (LegacyImportRecord kind "customer_product") is past sales history — the old
 *    system billed it, and nothing here ever will, so it would look unpaid for ever;
 *  - an order booked before the day Deskzo took over the books (the switch from Zoho Books — Migration.switchDate) was
 *    invoiced in the old system too: the invoice that came across from it names no order here.
 *
 * Both stay on the customer for renewals and history; they are only not chased.
 */

/** The first day Deskzo does the billing: the switch day of the newest switch not undone, or null without one. */
export async function billedHereFrom(): Promise<Date | null> {
  try {
    const m = await db.migration.findFirst({ where: { undoneAt: null }, orderBy: { createdAt: "desc" }, select: { switchDate: true } });
    return m?.switchDate ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** The part of an order query that keeps only orders booked from that day — none left out without a switch. */
export function bookedFrom(from: Date | null): Prisma.CompanyProductWhereInput {
  if (!from) return {};
  return { OR: [{ bookedAt: { gte: from } }, { bookedAt: null, createdAt: { gte: from } }] };
}

/** Whether this order is old — the old CRM's, or booked before Deskzo took over the billing — so the old system billed it. */
export async function isOldOrder(order: { id: string; bookedAt: Date | null; createdAt: Date }): Promise<boolean> {
  const from = await billedHereFrom();
  if (from && (order.bookedAt ?? order.createdAt) < from) return true;
  return (await withoutOldCrmOrders([order])).length === 0;
}

const CHUNK = 5000;

/** The same orders without those the old CRM's import made. */
export async function withoutOldCrmOrders<T extends { id: string }>(orders: T[]): Promise<T[]> {
  if (orders.length === 0) return orders;
  const imported = new Set<string>();
  try {
    for (let i = 0; i < orders.length; i += CHUNK) {
      const ids = orders.slice(i, i + CHUNK).map((o) => o.id);
      const rows = await db.legacyImportRecord.findMany({ where: { kind: "customer_product", recordId: { in: ids } }, select: { recordId: true } });
      for (const r of rows) imported.add(r.recordId);
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return imported.size ? orders.filter((o) => !imported.has(o.id)) : orders;
}
