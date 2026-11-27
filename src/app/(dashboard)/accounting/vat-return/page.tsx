import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { getVatReturn } from "@/actions/vat-return";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Amount, ReportHeader } from "@/components/accounting/report-chrome";
import { VatReturnCsv } from "@/components/accounting/vat-return-csv";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { getOrganisation } from "@/lib/organisation";
import { workspacePack } from "@/lib/country-pack";
import { workspaceClock } from "@/lib/time/workspace";
import { vatPeriod } from "@/lib/vat/return";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "VAT Return" };

/**
 * Accounting › VAT Return (owner, 31 Oct 2026 — src/lib/vat/return.ts): the UAE's VAT 201 for a quarter or a month, as
 * the FTA's EmaraTax form lays it out. Defaults to last quarter, the one being filed. A UAE workspace's, for whoever
 * manages payments — India's GST returns are its own page.
 */
export default async function VatReturnPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  if (!(await viewerHas("payments.manage"))) notFound();
  if (workspacePack().country !== "AE") notFound();

  const today = (await workspaceClock()).today();
  const [y, m] = today.split("-").map(Number) as [number, number];
  const quarter = Math.floor((m - 1) / 3) + 1;
  const lastQuarter = quarter === 1 ? `${y - 1}-Q4` : `${y}-Q${quarter - 1}`;
  const { period: asked } = await searchParams;
  const key = asked && vatPeriod(asked) ? asked : lastQuarter;

  // The last eight quarters and twelve months: a quarterly filer picks a quarter, a monthly one a month.
  const quarters = Array.from({ length: 8 }, (_, i) => {
    const n = y * 4 + (quarter - 1) - i;
    return `${Math.floor(n / 4)}-Q${(n % 4) + 1}`;
  });
  const months = Array.from({ length: 12 }, (_, i) => {
    const n = y * 12 + (m - 1) - i;
    return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
  });

  const [result, org] = await Promise.all([getVatReturn(key), getOrganisation()]);
  if (!result.ok) return <p className="text-sm text-danger">{result.error}</p>;
  const { vat, period, csv } = result.data;
  // Return and payment: 28 days after the period ends.
  const due = new Date(new Date(`${period.to}T00:00:00Z`).getTime() + 28 * 86_400_000);

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="VAT Return"
        subtitle={`${period.label} · VAT 201 · return and payment due ${formatCalendarDay(due)}`}
        organisation={`${org.legalName}${org.gstin ? ` · TRN ${org.gstin}` : ""}`}
      >
        <div className="flex flex-wrap items-end gap-3">
          <SelectParamFilter
            paramName="period"
            label="Period"
            allLabel={vatPeriod(lastQuarter)!.label}
            options={[...quarters.filter((q) => q !== lastQuarter), ...months].map((p) => ({ value: p, label: vatPeriod(p)!.label }))}
            resetParams={[]}
          />
          <VatReturnCsv csv={csv} fileName={`vat-201-${period.key}.csv`} />
        </div>
      </ReportHeader>

      {!org.gstin && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-2.5 text-sm text-warning">
          No TRN yet. Add it under Settings → Organisation — it goes on every tax invoice and this return.
        </Card>
      )}
      {vat.withoutEmirate.length > 0 && (
        <Card className="mt-4 flex gap-2 border-warning/40 bg-warning-bg px-4 py-2.5 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {vat.withoutEmirate.length} sale(s) were raised from a branch with no emirate in its address ({vat.withoutEmirate.slice(0, 5).map((d) => d.number).join(", ")}
            {vat.withoutEmirate.length > 5 ? "…" : ""}). Box 1 is reported by emirate: set the state on the branch, or on Settings → Organisation.
          </span>
        </Card>
      )}

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Box</th>
              <th className="px-4 py-2.5">VAT on sales and all other outputs</th>
              <th className="px-4 py-2.5 text-right">Amount (AED)</th>
              <th className="px-4 py-2.5 text-right">VAT (AED)</th>
            </tr>
          </thead>
          <tbody>
            {vat.box1.map((row, i) => (
              <Row key={row.emirate} box={`1${String.fromCharCode(97 + i)}`} label={`Standard rated supplies in ${row.emirate}`} amount={row.amount} tax={row.vat} />
            ))}
            <Row box="2" label="Tax refunds provided to tourists — from the portal" />
            <Row box="3" label="Supplies subject to the reverse charge" amount={vat.box3.amount} tax={vat.box3.vat} />
            <Row box="4" label="Zero rated supplies" amount={vat.box4} />
            <Row box="5" label="Exempt supplies" amount={vat.box5} />
            <Row box="6" label="Goods imported into the UAE — on reverse-charge bills from vendors abroad; the portal fills it from Customs too" amount={vat.box6.amount} tax={vat.box6.vat} />
            <Row box="7" label="Adjustments to goods imported into the UAE — from the portal" />
            {vat.badDebtRelief > 0 &&
              vat.box1
                .filter((row) => row.adjustment !== 0)
                .map((row) => (
                  <Row key={`adj-${row.emirate}`} box="1 adj." label={`Bad-debt relief in ${row.emirate} — VAT on invoices written off this period; enter it in Box 1's adjustment column`} tax={row.adjustment} />
                ))}
            <Row box="8" label="Totals" amount={vat.box8.amount} tax={vat.box8.vat} bold />
          </tbody>
        </table>
      </Card>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Box</th>
              <th className="px-4 py-2.5">VAT on expenses and all other inputs</th>
              <th className="px-4 py-2.5 text-right">Amount (AED)</th>
              <th className="px-4 py-2.5 text-right">Recoverable VAT (AED)</th>
            </tr>
          </thead>
          <tbody>
            <Row box="9" label="Standard rated expenses" amount={vat.box9.amount} tax={vat.box9.vat} />
            <Row box="10" label="Supplies subject to the reverse charge" amount={vat.box10.amount} tax={vat.box10.vat} />
            <Row box="11" label="Totals" amount={vat.box11.amount} tax={vat.box11.vat} bold />
          </tbody>
        </table>
      </Card>

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-sm">
          <tbody>
            <Row box="12" label="Total value of due tax for the period" tax={vat.box12} />
            <Row box="13" label="Total value of recoverable tax for the period" tax={vat.box13} />
            <Row box="14" label={vat.box14 < 0 ? "Refundable tax for the period" : "Payable tax for the period"} tax={Math.abs(vat.box14)} bold />
          </tbody>
        </table>
      </Card>

      <p className="mt-3 max-w-3xl text-xs text-subtle">
        From {vat.documents} issued invoice(s), credit and debit notes, bills and vendor credits dated in the period, each in AED at its own rate.
        Out-of-scope lines are in no box. Not worked out here: tourist refunds, adjustments to imports (box 7), and the adjustment columns (bad-debt relief,
        apportionment) — enter those on EmaraTax. Check the figures with your accountant before filing.
      </p>
    </div>
  );
}

/** One box of the form: its number, its words, the amount and the VAT — either blank where the box has none. */
function Row({ box, label, amount, tax, bold }: { box: string; label: string; amount?: number; tax?: number; bold?: boolean }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="w-14 px-4 py-2 text-xs text-muted">{box}</td>
      <td className={`px-4 py-2 ${bold ? "font-medium text-text" : "text-text"}`}>{label}</td>
      <td className="px-4 py-2 text-right">{amount === undefined ? "" : <Amount value={amount} bold={bold} />}</td>
      <td className="px-4 py-2 text-right">{tax === undefined ? "" : <Amount value={tax} bold={bold} />}</td>
    </tr>
  );
}
