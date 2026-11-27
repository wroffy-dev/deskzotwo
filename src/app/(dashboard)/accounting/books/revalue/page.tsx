import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { viewerHas } from "@/actions/permission";
import { getFxRevaluationPreview, listFxRevaluations } from "@/actions/fx-revaluation";
import { getOrganisation } from "@/lib/organisation";
import { indiaClock } from "@/lib/time/zone";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { Card } from "@/components/ui/card";
import { FxRevaluationManager } from "@/components/accounting/fx-revaluation-manager";

/** The last day of the month before today's, in India — the usual day a period is revalued at. */
function lastMonthEnd(): string {
  const first = new Date(`${indiaClock.today().slice(0, 8)}01T00:00:00.000Z`);
  return new Date(first.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Revalue foreign balances (owner, 30 Oct 2026), beside Close the Books and gated as its close is: `books.close`. The
 * books keep India's calendar, so the day is India's.
 */
export default async function RevaluePage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  if (!(await viewerHas("books.close"))) notFound();

  const params = await searchParams;
  const asOf = params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf) && indiaClock.startOfDay(params.asOf) ? params.asOf : lastMonthEnd();
  const [loaded, history, org] = await Promise.all([getFxRevaluationPreview({ asOf }), listFxRevaluations(), getOrganisation()]);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Revalue foreign balances"
        subtitle="Open foreign receivables, payables and bank balances at a day's closing rate"
        organisation={org.legalName}
      />
      <div className="mt-5">
        {!loaded || loaded.notReady ? (
          <Card className="px-6 py-10 text-center text-sm text-muted">
            This workspace&apos;s database hasn&apos;t been updated for revaluations yet. Try again after the next update.
          </Card>
        ) : (
          <>
            {loaded.error && <Card className="mb-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{loaded.error}</Card>}
            <FxRevaluationManager asOf={asOf} initial={loaded.preview} history={history} canPost />
          </>
        )}
      </div>
    </div>
  );
}
