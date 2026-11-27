import { db } from "@/lib/db";

/**
 * Where a company came from, and how much of Zoho Books' invoicing is under it (owner, 14 Nov 2026: "show which record
 * came from Zoho Books and which came from old CRM … any record which has invoice done in Zoho wins").
 *
 *   · Zoho Books — the Zoho customer or vendor it was made from or linked to in the old-system import
 *     (src/lib/legacy-import/apply.ts logs them as zoho_contacts / zoho_vendors).
 *   · Old CRM — a WroffyCRM customer, vendor or a prospect a lead or profiling made (customers / vendors /
 *     prospect-company in the same log). A company can be both: the import pairs a Zoho record with a WroffyCRM one.
 *   · Zoho invoices — Zoho Books invoices under it: earlier years' in the archive (books_archived_documents), and this
 *     year's brought across by the mid-year switch (books_migration_records, each a Deskzo tax invoice now).
 *
 * In a merge the one with Zoho invoices is kept: the books, statements and GST returns were filed under it.
 */
export type CompanyOrigin = { zoho: boolean; oldCrm: boolean; zohoInvoices: number };

const ZOHO_KINDS = ["zoho_contacts", "zoho_vendors"];
const OLD_CRM_KINDS = ["customers", "vendors", "prospect-company"];
const NONE: CompanyOrigin = { zoho: false, oldCrm: false, zohoInvoices: 0 };

/** A workspace without the import's tables yet (before their migrations) has nothing from either. */
async function orEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch {
    return [];
  }
}

/** Every company with an origin or a Zoho invoice; any other is NONE (made in Deskzo). */
export async function companyOrigins(): Promise<{ of: (companyId: string) => CompanyOrigin }> {
  const [logged, archived, migrated] = await Promise.all([
    orEmpty(db.legacyImportRecord.findMany({ where: { kind: { in: [...ZOHO_KINDS, ...OLD_CRM_KINDS] } }, select: { kind: true, recordId: true } })),
    orEmpty(db.archivedDocument.groupBy({ by: ["companyId"], where: { kind: "INVOICE", companyId: { not: null } }, _count: { _all: true } })),
    orEmpty(db.migrationRecord.findMany({ where: { kind: "document" }, select: { recordId: true } })),
  ]);
  // This year's, a few thousand ids a query: a whole year of documents is more than one query's parameters hold.
  const thisYear: { companyId: string; _count: { _all: number } }[] = [];
  for (let i = 0; i < migrated.length; i += 5_000) {
    const ids = migrated.slice(i, i + 5_000).map((m) => m.recordId);
    thisYear.push(...(await orEmpty(db.tradeDocument.groupBy({ by: ["companyId"], where: { id: { in: ids }, docType: "INVOICE" }, _count: { _all: true } }))));
  }
  const map = new Map<string, CompanyOrigin>();
  const at = (id: string) => {
    let o = map.get(id);
    if (!o) map.set(id, (o = { zoho: false, oldCrm: false, zohoInvoices: 0 }));
    return o;
  };
  for (const r of logged) {
    if (ZOHO_KINDS.includes(r.kind)) at(r.recordId).zoho = true;
    else at(r.recordId).oldCrm = true;
  }
  for (const a of archived) if (a.companyId) at(a.companyId).zohoInvoices += a._count._all;
  for (const t of thisYear) at(t.companyId).zohoInvoices += t._count._all;
  return { of: (id) => map.get(id) ?? NONE };
}
