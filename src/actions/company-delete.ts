"use server";

import { revalidatePath } from "next/cache";
import type { CompanyRelationshipType } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { can } from "@/lib/authz/resolve";
import { deleteCompanyRecord } from "@/lib/companies/delete-company";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import type { ActionResult } from "@/actions/company";

/**
 * Deleting a company — customer, prospect, vendor or any other: the workspace's super admin's (owner, 27 Oct 2026),
 * and a vendor's also whoever holds "Delete vendors" — admins, and anyone given it (owner, 28 Oct 2026). Never while
 * viewing as someone else, and only one nothing has happened with (src/lib/companies/delete-company.ts). Written to
 * the audit log.
 */

const BULK_LIMIT = 200;

/** Whether this person may delete vendors: the super admin, or "Delete vendors". */
async function mayDeleteVendors(userId: string): Promise<boolean> {
  return (await actingAsSuperAdmin(userId)) || (await can(userId, "vendors.delete"));
}

const refresh = () => {
  for (const path of ["/customers", "/vendors", "/companies", "/prospects"]) revalidatePath(path);
};

export async function deleteCompany(companyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const id = String(companyId ?? "");
  if (!(await actingAsSuperAdmin(user.id))) {
    const company = await db.company.findUnique({ where: { id }, select: { relationshipType: true } });
    const vendor = !!company && isVendorRelationshipType(company.relationshipType as CompanyRelationshipType);
    if (!vendor || !(await can(user.id, "vendors.delete"))) return { ok: false, error: "Only the workspace's super admin can delete companies; a vendor, also whoever may delete vendors." };
  }
  const result = await deleteCompanyRecord(id);
  if (!result.ok) return { ok: false, error: result.error };
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: id, entityLabel: `Deleted ${result.name} (${result.relationshipType.toLowerCase().replace(/_/g, " ")})` });
  refresh();
  return { ok: true, data: null };
}

/**
 * The vendors ticked in the Vendors list, deleted one by one (owner, 28 Oct 2026). Each that has history stays and
 * is named with why; the rest go. Only vendors — a customer ticked on another list is never this action's.
 */
export async function bulkDeleteVendors(companyIds: string[]): Promise<ActionResult<{ deleted: number; kept: { name: string; why: string }[] }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await mayDeleteVendors(user.id))) return { ok: false, error: "Deleting vendors needs \"Delete vendors\" — admins have it." };
  const ids = [...new Set((Array.isArray(companyIds) ? companyIds : []).map((x) => String(x ?? "")).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Tick the vendors to delete." };
  if (ids.length > BULK_LIMIT) return { ok: false, error: `Up to ${BULK_LIMIT} at a time.` };
  const companies = await db.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, relationshipType: true } });
  let deleted = 0;
  const kept: { name: string; why: string }[] = [];
  for (const c of companies) {
    if (!isVendorRelationshipType(c.relationshipType as CompanyRelationshipType)) {
      kept.push({ name: c.name, why: "not a vendor" });
      continue;
    }
    const result = await deleteCompanyRecord(c.id);
    if (!result.ok) {
      kept.push({ name: c.name, why: result.error });
      continue;
    }
    deleted += 1;
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: c.id, entityLabel: `Deleted ${result.name} (${result.relationshipType.toLowerCase().replace(/_/g, " ")}) — with ${ids.length} ticked in the Vendors list` });
  }
  if (deleted) refresh();
  return { ok: true, data: { deleted, kept } };
}
