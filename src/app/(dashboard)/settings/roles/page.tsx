import { redirect } from "next/navigation";
import { acPath } from "@/lib/access-control/nav";

/**
 * Roles & Permissions moved into Settings › Access Control. A saved link — a bookmark, an old
 * notification, an email — lands on the screen that replaced the tab it named:
 *
 * - no role → the roles list;
 * - Module Access (and Summary, Business Rules) → the Module Matrix on that role;
 * - Record Access → Data Scope; Field Permissions → Field Permissions;
 * - Users → Employee Permissions.
 *
 * Each of those checks `permissions.view` itself, as this page did.
 */
export default async function RetiredRolesPage({ searchParams }: { searchParams: Promise<{ role?: string; tab?: string }> }) {
  const { role, tab } = await searchParams;
  if (!role) redirect(acPath.roles());
  if (tab === "records") redirect(acPath.scope({ role }));
  if (tab === "fields") redirect(acPath.fields({ role }));
  if (tab === "users") redirect(`${acPath.employees()}?role=${encodeURIComponent(role)}`);
  redirect(acPath.modules({ role }));
}
