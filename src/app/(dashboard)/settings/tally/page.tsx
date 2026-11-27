import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { workspaceClock } from "@/lib/time/workspace";
import { accountsToMap, listExports, tallyConfig, tallyNames } from "@/lib/tally/server";
import { TallySettings } from "@/components/settings/tally-settings";

export const metadata = { title: "Tally" };
export const dynamic = "force-dynamic";

/**
 * Settings › Tally (owner, 25 Oct 2026 plan; built 23 Nov 2026 — src/lib/tally): billing in Deskzo, books in Tally. Whoever
 * may close the books (the switch and the mapping) or export finance data (the exports); a 404 for anybody else.
 */
export default async function TallyPage() {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const user = await requireUser();
  const [canSetUp, canExport] = await Promise.all([can(user.id, "books.close"), can(user.id, "data.exportFinance")]);
  if (!canSetUp && !canExport) notFound();
  const config = await tallyConfig();
  if (!config.migrated) return <p className="text-sm text-muted">This workspace is still being updated. Try again in a few minutes.</p>;
  const [accounts, names, exports, clock] = await Promise.all([accountsToMap(), tallyNames(), listExports(), workspaceClock()]);
  const today = clock.today();
  // The next export starts the day after the last one ended — else from the start date, else this month's first.
  const last = exports[0]?.to;
  const after = last ? new Date(new Date(`${last}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10) : null;
  const defaultFrom = [after, config.startDate].filter((d): d is string => !!d).sort().pop() ?? `${today.slice(0, 8)}01`;
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Tally</h1>
        <p className="mt-1 text-sm text-muted">
          Keep your books in Tally and do the selling and billing in Deskzo: each period&apos;s invoices, credit and debit notes and receipts go to Tally as two files
          the accountant imports — never typed twice. One direction only: what is entered in Tally doesn&apos;t come back.
        </p>
      </div>
      <TallySettings config={config} accounts={accounts} ledgers={names.ledgers} exports={exports} canSetUp={canSetUp} canExport={canExport} defaultFrom={defaultFrom > today ? today : defaultFrom} today={today} />
    </div>
  );
}
