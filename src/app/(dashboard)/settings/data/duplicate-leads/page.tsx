import { notFound } from "next/navigation";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { findDuplicateLeads } from "@/lib/leads/duplicates";
import { currentUser } from "@/lib/session";
import { Badge } from "@/components/ui/card";
import { DuplicateLeads } from "@/components/leads/duplicate-leads";

export const metadata = { title: "Duplicate leads" };

/**
 * Settings › Data & continuity › Duplicate leads (owner, 30 Oct 2026 — src/lib/leads/duplicates.ts): the copies an
 * import made of leads already here, reviewed and taken away. The workspace's super admin's alone, acting as
 * themselves, as deleting a lead is; for anyone else the page isn't there.
 */
export default async function DuplicateLeadsPage() {
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) notFound();
  // As the viewer's leads policy shows them in a list (owner, 5 Nov 2026 — Phase 3 masking fixes).
  const groups = await findDuplicateLeads(user.id);
  // Plain values across to the client: dates as strings.
  const plain = groups.map((g) => ({
    ...g,
    keep: { ...g.keep, createdAt: g.keep.createdAt.toISOString() },
    copies: g.copies.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
  }));
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">Duplicate leads</h1>
          <Badge tone="brand">Super Admin only</Badge>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Leads an import brought in again: the same company, pipeline, title and contact as a lead already here. The lead
          that was here first is kept; tick the copies to take away. A copy somebody has worked on — a call, a task, a
          quotation, a note — is never taken away; open it and sort it out by hand.
        </p>
      </div>
      <DuplicateLeads groups={plain} />
    </div>
  );
}
