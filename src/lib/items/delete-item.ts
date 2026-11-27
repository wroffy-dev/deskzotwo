import { db } from "@/lib/db";

/**
 * Deleting an item — the super admin's alone (owner, 27 Oct 2026; src/actions/item.ts deleteItem) — and only one
 * nothing has used: an item takes its stock movements, batches and serials with it when it goes, and orders, lead
 * requirements and document lines can't lose it. One that has any is refused, the refusal naming what it has; what
 * goes with one that has none is its own units, reseller prices and (empty) stock balances.
 */

const COUNTERS: { what: string; count: (id: string) => Promise<number> }[] = [
  { what: "orders", count: (id) => db.companyProduct.count({ where: { itemId: id } }) },
  { what: "lead requirements", count: (id) => db.leadRequirement.count({ where: { itemId: id } }) },
  { what: "document lines (invoices, bills, quotes and the rest)", count: (id) => db.tradeDocumentLine.count({ where: { itemId: id } }) },
  { what: "stock document lines", count: (id) => db.stockDocumentLine.count({ where: { itemId: id } }) },
  { what: "stock movements", count: (id) => db.stockMovement.count({ where: { itemId: id } }) },
  { what: "batches or serial numbers", count: async (id) => (await db.itemBatch.count({ where: { itemId: id } })) + (await db.itemSerial.count({ where: { itemId: id } })) },
  { what: "assets", count: (id) => db.asset.count({ where: { itemId: id } }) },
  { what: "schedules", count: (id) => db.revenueSchedule.count({ where: { itemId: id } }) },
];

export async function itemDeleteBlockers(itemId: string) {
  const counts = await Promise.all(COUNTERS.map(async (c) => ({ what: c.what, count: await c.count(itemId) })));
  return counts.filter((c) => c.count > 0);
}

/** Deletes an item nothing has used; else says why not. */
export async function deleteItemRecord(itemId: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true, name: true } });
  if (!item) return { ok: false, error: "That item isn't there." };
  const blockers = await itemDeleteBlockers(item.id);
  if (blockers.length) {
    const list = blockers.map((b) => `${b.count.toLocaleString("en-IN")} ${b.what}`).join(", ");
    return { ok: false, error: `${item.name} has ${list}, so it can't be deleted. Mark it inactive instead.` };
  }
  try {
    await db.item.delete({ where: { id: item.id } });
  } catch {
    return { ok: false, error: `${item.name} is still used somewhere in Deskzo, so it can't be deleted. Mark it inactive instead.` };
  }
  return { ok: true, name: item.name };
}
