import { db } from "@/lib/db";
import { companyScope } from "@/lib/authz/company-scope";
import { CATEGORY_SELECT } from "@/lib/customers/categories";

/**
 * One company as an unfiltered picker would offer it, or null (owner, 30 Oct 2026). The ticket and visit
 * forms now send only the first few hundred companies by name and search for the rest, so the record's
 * own company (an edit page) or the one the URL names (`?companyId=`) can fall outside that page — this
 * puts it back, so the field can show its name.
 *
 * The same rule as `listCompanyOptions()` without kinds or a side (src/actions/company.ts): in this person's
 * scope, not disqualified, not a reseller's end customer. An id the list would not have offered answers
 * null, exactly as it was absent from the whole list before. Not a server action: it takes a user id.
 */
export async function companyPickerOption(userId: string, companyId: unknown) {
  // A repeated query parameter arrives as an array; that is no id.
  if (typeof companyId !== "string" || !companyId) return null;
  return db.company.findFirst({
    where: { id: companyId, AND: [await companyScope(userId)], stage: { not: "DISQUALIFIED" }, managedByResellerId: null },
    select: { id: true, name: true, relationshipType: true, customerCategory: { select: CATEGORY_SELECT } },
  });
}
