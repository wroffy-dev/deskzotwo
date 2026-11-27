import Link from "next/link";
import type { ReactNode } from "react";
import { openMigration } from "@/lib/migration/state";
import { keptInTally } from "@/lib/tally/books";
import { KeptInTallyGate } from "@/components/accounting/kept-in-tally";

/**
 * While the rest of a financial year is being brought across from the old system (src/lib/migration), every
 * accounting page says its figures for those months aren't final: what is imported so far is in the books,
 * and Undo can still take all of it back. Nothing is said once it's finished or when there is none.
 */
export default async function AccountingLayout({ children }: { children: ReactNode }) {
  const [migration, tally] = await Promise.all([openMigration(), keptInTally()]);
  return (
    <>
      {migration && (
        <div role="status" className="mb-4 rounded-xl border border-warning/40 bg-warning-bg/40 px-4 py-2.5 text-sm text-text">
          <span className="font-medium">Migration in progress — figures not final.</span>{" "}
          <span className="text-muted">
            The year from {migration.yearStart} up to {migration.switchDate} is still being brought across from the old system.{" "}
            <Link href="/settings/data/switch" className="text-brand hover:underline">
              See where it&apos;s got to
            </Link>
          </span>
        </div>
      )}
      {/* Tally keeps the books (src/lib/tally): its pages say "Kept in Tally" instead. */}
      <KeptInTallyGate on={tally}>{children}</KeptInTallyGate>
    </>
  );
}
