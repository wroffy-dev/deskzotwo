import { notFound } from "next/navigation";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { countLeads } from "@/lib/leads/delete-all";
import { currentUser } from "@/lib/session";
import { Badge } from "@/components/ui/card";
import { DeleteAllLeads } from "@/components/leads/delete-all-leads";

export const metadata = { title: "Delete all leads" };

/**
 * Settings › Data & continuity › Delete all leads (owner, 30 Oct 2026 — src/lib/leads/delete-all.ts): every lead gone,
 * after a backup, to import them again from a clean file. The super admin's alone, as deleting one lead is; for anyone
 * else the page isn't there.
 */
export default async function DeleteAllLeadsPage() {
  const user = await currentUser();
  // The catalogue's gate (settings.manage), and the super admin's alone as deleting a lead is.
  if (!user || !(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) notFound();
  const total = await countLeads();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">Delete all leads</h1>
          <Badge tone="brand">Super Admin only</Badge>
        </div>
        <div className="mt-1 max-w-3xl space-y-2 text-sm text-muted">
          <p>
            For starting the leads again from a clean import. Every lead goes, with its activity, tasks, notes, products and
            proposals. Quotations, calls, visits and expenses stay, no longer linked to a lead. Companies and contacts stay —
            the import finds them again by name and email.
          </p>
          <p>
            A full backup is taken first and kept for 30 days; restoring it from Settings › Backups undoes this. New leads
            carry on from the next lead number.
          </p>
        </div>
      </div>
      <DeleteAllLeads total={total} />
    </div>
  );
}
