import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { byStageDate } from "@/lib/pipeline/server";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";

/**
 * "Pay once the money is in" for leads raised and won (owner, 1 Nov 2026) — src/actions/incentive.ts.
 *
 * The person raised the lead, so it isn't their invoices as salesperson that count but the lead's own:
 * the invoices made from its quotation, which carry its lead (src/actions/trade-document.ts), whenever
 * they were issued. The leads are those the measure counts (src/lib/targets/measure.ts): raised by the
 * person, owned and won by somebody else in the window. A won lead with no such invoice yet means nothing
 * is collected yet, and the scheme holds — the safe direction.
 */

export function raisedLeadMetric(metric: string): boolean {
  return metric === "LEADS_RAISED_WON" || metric === "LEAD_VALUE_RAISED_WON";
}

export type CollectionInvoice = { total: Prisma.Decimal; payments: { amount: Prisma.Decimal }[] };

const INVOICE_FOR_COLLECTION = {
  docType: "INVOICE",
  status: { notIn: ["DRAFT", "CANCELLED"] },
  ...RAISED_IN_DESKZO,
} satisfies Prisma.TradeDocumentWhereInput;

/** Each person's raised leads' invoices, for the leads won in the window. */
export async function raisedLeadInvoices(userIds: string[], from: Date, to: Date): Promise<Map<string, CollectionInvoice[]>> {
  const window = { gte: from, lte: to };
  const leads = await byStageDate((moved) =>
    db.lead.findMany({ where: { status: "WON", createdByUserId: { in: userIds }, ...moved(window) }, select: { id: true, createdByUserId: true, ownerUserId: true } }),
  );
  const raisedBy = new Map<string, string>();
  for (const l of leads) if (l.createdByUserId && l.ownerUserId !== l.createdByUserId) raisedBy.set(l.id, l.createdByUserId);
  const byUser = new Map<string, CollectionInvoice[]>();
  if (!raisedBy.size) return byUser;
  const invoices = await db.tradeDocument.findMany({
    where: { ...INVOICE_FOR_COLLECTION, leadId: { in: [...raisedBy.keys()] } },
    orderBy: { id: "asc" },
    select: { leadId: true, total: true, payments: { select: { amount: true } } },
  });
  for (const invoice of invoices) {
    const userId = invoice.leadId ? raisedBy.get(invoice.leadId) : undefined;
    if (!userId) continue;
    byUser.set(userId, [...(byUser.get(userId) ?? []), invoice]);
  }
  return byUser;
}
