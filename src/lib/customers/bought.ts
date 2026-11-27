import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Who has bought from us — what makes a company a customer (owner, 16 Nov 2026: "if any company has active or expired
 * order or even single invoicing done ! - it should show in customer"). Any one of:
 *
 *   · an order on file in Products & Subscriptions, active or expired (as it always was);
 *   · a tax invoice issued to it — not a draft, not cancelled;
 *   · an invoice the old system issued it, in the archive the Zoho switch brought (src/lib/migration/archive.ts) —
 *     not one Zoho marked void, cancelled, draft, rejected or waiting for approval (`neverOwed`).
 *
 * The Customers list, its count on the dashboard, its export and the Companies list's "has orders" buckets all ask
 * this, so one company is a customer everywhere or nowhere.
 */

/** The archive's invoices are kept by company id, not as a relation: the companies with one that counts. */
async function companiesInvoicedInArchive(): Promise<string[]> {
  try {
    const rows = await db.archivedDocument.findMany({
      where: {
        kind: "INVOICE",
        companyId: { not: null },
        // A status that's missing counts; one Zoho marked void, cancelled, draft, rejected or waiting for approval
        // doesn't (`neverOwed`). As an OR, not a NOT: NOT over a null column drops the row (memory:
        // prisma-not-over-null-drops-rows).
        OR: [
          { status: null },
          { AND: ["void", "cancel", "draft", "reject", "approv"].map((word) => ({ NOT: { status: { contains: word, mode: "insensitive" as const } } })) },
        ],
      },
      distinct: ["companyId"],
      select: { companyId: true },
    });
    return rows.map((r) => r.companyId!).filter(Boolean);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** A company that has bought from us: an order, an issued invoice, or an invoice in the old system's archive. */
export async function boughtFromUsWhere(): Promise<Prisma.CompanyWhereInput> {
  const archived = await companiesInvoicedInArchive();
  return {
    OR: [
      { products: { some: {} } },
      { tradeDocuments: { some: { docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } } } },
      ...(archived.length ? [{ id: { in: archived } }] : []),
    ],
  };
}
