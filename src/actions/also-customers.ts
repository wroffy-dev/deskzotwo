"use server";

import { revalidatePath } from "next/cache";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { mayAccess } from "@/lib/authz/access";
import { companyScope } from "@/lib/authz/company-scope";
import { setCompanyRole } from "@/lib/companies/roles";
import { vendorsMarkedAsCustomers } from "@/lib/companies/also-customers";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";

type Result = { ok: true; removed: number; skipped: number } | { ok: false; error: string };

/**
 * Takes "Also a customer" off the vendors picked on the review list, each looked at again here: one that has been sold to
 * since the page opened is left alone, and counted. Anything else comes off on its own page, where the sales can be seen
 * first (Roles). Whoever may change a company's role; never while viewing as somebody.
 */
export async function removeCustomerMarks(companyIds: string[]): Promise<Result> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await hasEffectivePermission(user.id, "companies.changeRole"))) return { ok: false, error: "Changing a company's role needs the right to — ask an admin." };
  const ids = [...new Set((Array.isArray(companyIds) ? companyIds : []).map(String))];
  if (ids.length === 0) return { ok: false, error: "Tick the vendors first." };
  if (ids.length > 1000) return { ok: false, error: "That's too many at once — 1,000 vendors at most." };

  const rows = await vendorsMarkedAsCustomers(await companyScope(user.id), ids);
  let removed = 0;
  for (const row of rows) {
    if (!row.noSales || !(await mayAccess(user.id, "companies", "edit", row.id))) continue;
    const changed = await setCompanyRole(row.id, "customer", false);
    if (!changed.ok) continue;
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: row.id, entityLabel: `${row.name} — no longer a customer (review of vendors marked as customers)` });
    removed += 1;
  }
  revalidatePath("/vendors");
  revalidatePath("/vendors/also-customers");
  revalidatePath("/customers");
  revalidatePath("/companies");
  return { ok: true, removed, skipped: ids.length - removed };
}
