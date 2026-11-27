import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { currentUser } from "@/lib/session";
import { Badge } from "@/components/ui/card";
import { OldProposalImports } from "@/components/settings/old-proposals-import";
import { OldProposalsPreview } from "@/components/settings/old-proposals-preview";
import { oldProposalImports, oldProposalsReady } from "@/lib/old-proposals/run";

export const metadata = { title: "Old proposals" };

/**
 * Settings › Data & continuity › Old CRM migration › Old proposals (owner, 25 Nov 2026; src/lib/old-proposals): the
 * proposals made in Excel before Zoho, matched to the companies here, brought in and taken back. The
 * workspace's super admin's alone, acting as themselves; for anyone else the page isn't there.
 */
export default async function OldProposalsPage() {
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) notFound();
  const ready = await oldProposalsReady();
  const imports = ready ? await oldProposalImports() : [];
  return (
    <div className="animate-fade-rise">
      <p className="text-xs text-muted">
        <Link href="/settings/data/old-crm" className="hover:underline">
          Old CRM migration
        </Link>{" "}
        ›
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-text">Old proposals</h1>
        <Badge tone="brand">Super Admin only</Badge>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        The proposals made in Excel before Zoho, matched to the companies here: which come in, which need a look, and which companies are made. Choose the file
        prepared from the folder to see it first — nothing is written until you bring them in, a full backup is taken before, and it can be undone.
      </p>
      <OldProposalImports imports={imports} />
      <OldProposalsPreview canImport={ready && !imports.some((i) => i.status === "IMPORTING")} />
    </div>
  );
}
