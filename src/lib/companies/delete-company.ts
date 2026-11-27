import { db } from "@/lib/db";

/**
 * Deleting a company — a customer, a prospect, a vendor, any of them (owner, 27 Oct 2026: the super admin's alone —
 * src/actions/company-delete.ts). Only one nothing has happened with: a company row takes its payments, orders,
 * tickets, leads and TDS certificates with it when it goes, and its documents and the books can't lose it at all.
 * So one with any of these is refused, and the refusal names what it has; what goes with one that has none is its
 * own details — contacts, addresses, bank accounts, statement mappings and notes.
 */

export type CompanyBlocker = { what: string; count: number };

const COUNTERS: { what: string; count: (id: string) => Promise<number> }[] = [
  { what: "documents (invoices, bills, proposals and the rest)", count: (id) => db.tradeDocument.count({ where: { companyId: id } }) },
  { what: "payments", count: (id) => db.payment.count({ where: { companyId: id } }) },
  { what: "vendor credits", count: (id) => db.vendorCredit.count({ where: { vendorId: id } }) },
  { what: "journal entries", count: async (id) => (await db.journalEntry.count({ where: { companyId: id } })) + (await db.journalLine.count({ where: { companyId: id } })) },
  { what: "vouchers", count: (id) => db.accountVoucher.count({ where: { companyId: id } }) },
  { what: "expenses", count: (id) => db.expense.count({ where: { companyId: id } }) },
  { what: "orders", count: (id) => db.companyProduct.count({ where: { OR: [{ companyId: id }, { vendorId: id }, { endCustomerId: id }] } }) },
  { what: "order expenses", count: (id) => db.orderExpense.count({ where: { payeeCompanyId: id } }) },
  { what: "stock documents", count: (id) => db.stockDocument.count({ where: { companyId: id } }) },
  { what: "TDS certificates", count: (id) => db.tdsCertificate.count({ where: { companyId: id } }) },
  { what: "schedules", count: async (id) => (await db.revenueSchedule.count({ where: { companyId: id } })) + (await db.accountingSchedule.count({ where: { vendorCompanyId: id } })) },
  { what: "projects", count: (id) => db.project.count({ where: { companyId: id } }) },
  { what: "tickets", count: (id) => db.ticket.count({ where: { companyId: id } }) },
  { what: "leads", count: (id) => db.lead.count({ where: { companyId: id } }) },
  { what: "tasks", count: (id) => db.task.count({ where: { companyId: id } }) },
  { what: "visits", count: (id) => db.visit.count({ where: { companyId: id } }) },
  { what: "calls", count: (id) => db.callLog.count({ where: { companyId: id } }) },
  { what: "assets", count: (id) => db.asset.count({ where: { OR: [{ ownerCompanyId: id }, { vendorCompanyId: id }, { siteCompanyId: id }] } }) },
  { what: "fixed assets", count: (id) => db.fixedAsset.count({ where: { vendorCompanyId: id } }) },
  { what: "companies it manages as their reseller", count: (id) => db.company.count({ where: { managedByResellerId: id } }) },
];

/** What a company has that keeps it from being deleted; none means it can go. */
export async function companyDeleteBlockers(companyId: string): Promise<CompanyBlocker[]> {
  const counts = await Promise.all(COUNTERS.map(async (c) => ({ what: c.what, count: await c.count(companyId) })));
  return counts.filter((c) => c.count > 0);
}

export type CompanyDeleteRefusal = { error: string; blockers?: CompanyBlocker[] };

/** Deletes a company nothing has happened with; else says why not. */
export async function deleteCompanyRecord(companyId: string): Promise<{ ok: true; name: string; relationshipType: string } | ({ ok: false } & CompanyDeleteRefusal)> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, relationshipType: true } });
  if (!company) return { ok: false, error: "That company isn't there." };
  const blockers = await companyDeleteBlockers(company.id);
  if (blockers.length) {
    const list = blockers.map((b) => `${b.count.toLocaleString("en-IN")} ${b.what}`).join(", ");
    return { ok: false, error: `${company.name} has ${list}, so it can't be deleted — they would go with it, or lose it.`, blockers };
  }
  try {
    await db.company.delete({ where: { id: company.id } });
  } catch {
    // Something not counted above still points at it: refused rather than lost.
    return { ok: false, error: `${company.name} is still used somewhere in Deskzo, so it can't be deleted.` };
  }
  return { ok: true, name: company.name, relationshipType: company.relationshipType };
}
