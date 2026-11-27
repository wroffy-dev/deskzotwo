import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { db } from "@/lib/db";
import type { Analysis } from "@/lib/legacy-import/analyse";
import { masterCounts } from "@/lib/legacy-import/master";
import { currentDraft, runHistory } from "@/lib/legacy-import/store";
import { currentUser } from "@/lib/session";
import { Badge } from "@/components/ui/card";
import { LegacyImportWizard } from "@/components/settings/legacy-import-wizard";

export const metadata = { title: "Old CRM migration" };

/**
 * Settings › Data & continuity › Old CRM migration (owner, 26 Oct 2026; src/lib/legacy-import): the old CRM's export
 * brought into Deskzo — uploaded, previewed, imported with a backup first, and undone if need be. The workspace's
 * super admin's alone, acting as themselves; for anyone else the page isn't there.
 */
export default async function OldCrmMigrationPage() {
  const user = await currentUser();
  // Settings (as its link says), and then only the super admin acting as themselves.
  if (!user || !(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) notFound();

  const tablesReady = await db.legacyImport
    .count()
    .then(() => true)
    .catch(() => false);
  if (!tablesReady) {
    return (
      <div className="max-w-xl">
        <h1 className="text-xl font-semibold text-text">Old CRM migration</h1>
        <p className="mt-2 text-sm text-muted">This workspace&apos;s database is still to be updated for the migration tool. Try again after the next update.</p>
      </div>
    );
  }

  const [draft, history, running] = await Promise.all([
    currentDraft(),
    runHistory(),
    db.legacyImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } }),
  ]);
  const counts = draft ? await masterCounts(draft.id) : {};
  const analysis = draft ? ((await db.legacyImport.findUnique({ where: { id: draft.id }, select: { analysis: true } }))?.analysis as unknown as Analysis | null) : null;

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold text-text">Old CRM migration</h1>
        <Badge tone="brand">Super Admin only</Badge>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Bring the old CRM&apos;s data across from its export: customers, their contacts and addresses, products, leads, profilings, the renewals book,
        tickets and their replies, field visits and call logs. Nothing is written until you&apos;ve seen the preview and confirmed; a full backup is
        taken first, every record is logged against its id in the old CRM so the same files never come in twice, and an import can be undone.
      </p>
      <p className="mt-1 text-sm text-muted">
        Proposals made in Excel before that?{" "}
        <Link href="/settings/data/old-proposals" className="text-brand hover:underline">
          Preview the old proposals
        </Link>
      </p>
      <LegacyImportWizard
        draft={draft ? { id: draft.id, files: draft.files } : null}
        analysis={analysis}
        runningId={running?.id ?? null}
        masterCounts={counts}
        history={history.map((h) => ({
          id: h.id,
          status: h.status,
          strategy: h.strategy,
          createdAt: h.createdAt.toISOString(),
          finishedAt: h.finishedAt?.toISOString() ?? null,
          undoneAt: h.undoneAt?.toISOString() ?? null,
          records: h.records,
          errors: h.errors,
          progress: JSON.parse(JSON.stringify(h.progress ?? {})) as Record<string, unknown>,
        }))}
      />
    </div>
  );
}
