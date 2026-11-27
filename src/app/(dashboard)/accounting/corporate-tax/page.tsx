import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { corporateTaxBase } from "@/actions/corporate-tax";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportHeader } from "@/components/accounting/report-chrome";
import { CorporateTaxWorkingView } from "@/components/accounting/corporate-tax-working";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { getOrganisation } from "@/lib/organisation";
import { workspacePack } from "@/lib/country-pack";
import { financialYearStartOf, fyLabel } from "@/lib/india-time";
import { corporateTaxDue } from "@/lib/corporate-tax";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Corporate Tax" };

/**
 * Accounting › Corporate Tax (owner, 14 Nov 2026 — src/lib/corporate-tax.ts): the UAE's Corporate Tax working for a tax
 * period, from the books' revenue and profit. Defaults to the last finished financial year, the one being filed.
 */
export default async function CorporateTaxPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  if (!(await viewerHas("payments.manage"))) notFound();
  if (workspacePack().country !== "AE") notFound();

  const current = financialYearStartOf(new Date());
  const years = Array.from({ length: 4 }, (_, i) => current - i);
  const { year: asked } = await searchParams;
  const year = years.includes(Number(asked)) ? Number(asked) : current - 1;

  const [result, org] = await Promise.all([corporateTaxBase(year), getOrganisation()]);
  if (!result.ok) return <p className="text-sm text-danger">{result.error}</p>;
  const base = result.data;

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="Corporate Tax"
        subtitle={`Tax period ${base.label} · ${formatCalendarDay(new Date(`${base.from}T00:00:00Z`))} – ${formatCalendarDay(new Date(`${base.to}T00:00:00Z`))} · return and tax due ${formatCalendarDay(new Date(`${corporateTaxDue(base.to)}T00:00:00Z`))}`}
        organisation={`${org.legalName}${org.gstin ? ` · TRN ${org.gstin}` : ""}`}
      >
        <SelectParamFilter
          paramName="year"
          label="Tax period"
          allLabel={fyLabel(current - 1)}
          options={years.filter((y) => y !== current - 1).map((y) => ({ value: String(y), label: y === current ? `${fyLabel(y)} (so far)` : fyLabel(y) }))}
          resetParams={[]}
        />
      </ReportHeader>

      <CorporateTaxWorkingView key={base.year} revenue={base.revenue} accountingProfit={base.accountingProfit} periodEnd={base.to} />

      <p className="mt-3 max-w-3xl text-xs text-subtle">
        Revenue and profit are the books&apos; Profit &amp; Loss for the period. 0% on the first AED 375,000 of taxable income, 9% above it. Interest
        limits, transfer pricing, group relief and losses brought forward aren&apos;t worked out here. This is a working, not a filing — check it with
        your tax adviser and file on EmaraTax.
      </p>
    </div>
  );
}
