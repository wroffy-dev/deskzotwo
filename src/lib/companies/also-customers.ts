import type { Prisma, TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { twoRolesHere } from "@/lib/companies/roles";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";

/**
 * Vendors marked "Also a customer", and whether anything was ever sold to them (owner, 5 Nov 2026 — "how come nisha as
 * sales manager see vendor?"): the Zoho import marks a vendor when a Zoho customer has its GSTIN or PAN
 * (src/lib/legacy-import/apply.ts), which can be a branch in another state, and a marked vendor is on the Customer list.
 *
 * Anything on the customer side counts as a sale here, a quote or a lead as much as an invoice, and the archive's older
 * years too: the question is whether the mark can come off with nothing left unexplained, not how much they bought.
 */

const SALES_DOCUMENTS: TradeDocumentType[] = ["PROPOSAL", "PROFORMA", "INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"];
/** The archive's kinds on the customer side (ArchivedDocument.kind). */
const ARCHIVED_SALES = ["INVOICE", "CREDIT_NOTE", "CUSTOMER_PAYMENT", "QUOTE", "SALES_ORDER"];

export type AlsoCustomerRow = {
  id: string;
  companySeq: number;
  name: string;
  /** Who looks after the customer side. */
  sideOwner: string | null;
  /** The Zoho import linked a Zoho customer to this vendor. */
  fromZoho: boolean;
  orders: number;
  documents: number;
  paymentsIn: number;
  leads: number;
  archived: number;
  /** Nothing on the customer side at all: the mark can come off. */
  noSales: boolean;
};

const countsBy = (rows: { companyId: string | null; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.companyId, r._count._all]));

/** These vendors, within `scope` (the viewer's), most sold-to last: the ones to look at first. */
export async function vendorsMarkedAsCustomers(scope: Prisma.CompanyWhereInput, only?: string[]): Promise<AlsoCustomerRow[]> {
  if (!(await twoRolesHere())) return [];
  const companies = await db.company.findMany({
    where: { AND: [{ alsoCustomer: true, relationshipType: { in: [...vendorRelationshipTypeValues] } }, scope, ...(only ? [{ id: { in: only } }] : [])] },
    orderBy: { name: "asc" },
    select: { id: true, companySeq: true, name: true, sideOwner: { select: { name: true } } },
  });
  const ids = companies.map((c) => c.id);
  if (ids.length === 0) return [];
  const companyId = { in: ids };
  const [orders, documents, paymentsIn, leads, archived, linked] = await Promise.all([
    db.companyProduct.groupBy({ by: ["companyId"], where: { companyId }, _count: { _all: true } }),
    db.tradeDocument.groupBy({ by: ["companyId"], where: { companyId, docType: { in: SALES_DOCUMENTS }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
    db.payment.groupBy({ by: ["companyId"], where: { companyId, direction: "RECEIVED" }, _count: { _all: true } }),
    db.lead.groupBy({ by: ["companyId"], where: { companyId }, _count: { _all: true } }),
    // The archive isn't in every workspace yet.
    db.archivedDocument.groupBy({ by: ["companyId"], where: { companyId, kind: { in: ARCHIVED_SALES } }, _count: { _all: true } }).catch((err: unknown) => {
      if (notMigratedYet(err)) return [];
      throw err;
    }),
    db.legacyImportRecord.findMany({ where: { kind: "zoho_contacts", action: "LINKED", recordId: { in: ids } }, select: { recordId: true } }),
  ]);
  const [o, d, p, l, a] = [countsBy(orders), countsBy(documents), countsBy(paymentsIn), countsBy(leads), countsBy(archived)];
  const zoho = new Set(linked.map((r) => r.recordId));
  const rows = companies.map((c) => {
    const row = { orders: o.get(c.id) ?? 0, documents: d.get(c.id) ?? 0, paymentsIn: p.get(c.id) ?? 0, leads: l.get(c.id) ?? 0, archived: a.get(c.id) ?? 0 };
    return {
      id: c.id,
      companySeq: c.companySeq,
      name: c.name,
      sideOwner: c.sideOwner?.name ?? null,
      fromZoho: zoho.has(c.id),
      ...row,
      noSales: row.orders + row.documents + row.paymentsIn + row.leads + row.archived === 0,
    };
  });
  return rows.sort((x, y) => Number(y.noSales) - Number(x.noSales));
}
