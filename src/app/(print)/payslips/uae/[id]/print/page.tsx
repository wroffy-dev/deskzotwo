import { notFound } from "next/navigation";
import { getUaePayslip } from "@/actions/uae-payroll";
import { isModuleEnabled } from "@/actions/module";
import { getOrganisation, foreignCountry } from "@/lib/organisation";
import { PrintButton } from "@/components/documents/print-button";
import { formatCurrency } from "@/lib/utils";
import { amountInWords } from "@/lib/gst-engine";
import { monthLabel } from "@/lib/hr/calendar";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * A UAE payslip as a page (owner, 15 Nov 2026 — src/lib/uae): printed, or saved as a PDF from the print dialog, as
 * India's payslip is. Black on white whatever the app's theme. `getUaePayslip` checks who may see it — the person, once
 * the month is locked, or payroll — so a leaked link shows nobody else anything.
 *
 * The salary is shown as earned for the days paid: each part of the monthly pay in proportion, so the parts add up to
 * what was paid before deductions.
 */
export default async function PrintUaePayslipPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ embed?: string }> }) {
  if (!(await isModuleEnabled("payroll"))) notFound();
  const [{ id }, { embed }] = await Promise.all([params, searchParams]);
  const [slip, org] = await Promise.all([getUaePayslip(id), getOrganisation()]);
  if (!slip) notFound();

  const monthly = slip.basic + slip.housing + slip.transport + slip.otherAllowance;
  const earned = Math.round((slip.fixed + slip.deductions) * 100) / 100;
  const parts = [
    { label: "Basic salary", value: slip.basic },
    { label: "Housing allowance", value: slip.housing },
    { label: "Transport allowance", value: slip.transport },
    { label: "Other allowances", value: slip.otherAllowance },
  ].filter((p) => p.value > 0);
  // Each part in proportion; the last takes the rounding, so the column adds up.
  let given = 0;
  const salaryRows = parts.map((p, i) => {
    const value = i === parts.length - 1 ? Math.round((earned - given) * 100) / 100 : Math.round(((p.value * earned) / (monthly || 1)) * 100) / 100;
    given += value;
    return { label: p.label, value };
  });
  const earnings = [...salaryRows, { label: "Overtime", value: slip.overtime }, { label: "Bonus", value: slip.bonus }].filter((r) => r.value > 0);
  const gross = earned + slip.overtime + slip.bonus;
  const daysPaid = Number(slip.payEnd.slice(8, 10)) - Number(slip.payStart.slice(8, 10)) + 1 - slip.unpaidDays;

  return (
    <div className="mx-auto max-w-3xl bg-white p-10 text-[13px] text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      {embed !== "1" && (
        <div className="mb-6 flex items-center justify-between print:hidden">
          <span className="text-xs text-neutral-500">{slip.status === "DRAFT" ? "Draft — the month isn't locked yet." : "Print, or choose “Save as PDF” in the print dialog."}</span>
          <PrintButton />
        </div>
      )}

      <header className="border-b-2 border-neutral-800 pb-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-wide">{org.legalName || "—"}</h1>
            {org.addressLine1 && <p className="mt-0.5 text-xs text-neutral-600">{org.addressLine1}</p>}
            {(org.city || org.state) && <p className="text-xs text-neutral-600">{[org.city, org.state, foreignCountry(org)].filter(Boolean).join(", ")}</p>}
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-neutral-500">Payslip for</p>
            <p className="text-base font-semibold">{monthLabel(slip.month, slip.year)}</p>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-8 gap-y-1 border-b border-neutral-300 py-4 text-xs">
        <Row label="Name" value={slip.name} strong />
        <Row label="Employee code" value={slip.employeeCode ?? "—"} />
        <Row label="Designation" value={slip.designation ?? "—"} />
        <Row label="Date of joining" value={slip.joinedOn ? formatCalendarDay(slip.joinedOn) : "—"} />
        <Row label="MOHRE person ID" value={slip.mohrePersonId ?? "—"} />
        <Row label="Paid to" value={slip.ibanLast4 ? `${slip.bankName ?? "Bank"} •••• ${slip.ibanLast4}` : "—"} />
        <Row label="Pay period" value={`${formatCalendarDay(slip.payStart)} – ${formatCalendarDay(slip.payEnd)}`} />
        <Row label="Days paid" value={`${daysPaid} of ${slip.monthDays}`} />
        {slip.unpaidDays > 0 && <Row label="Unpaid days" value={String(slip.unpaidDays)} />}
        <Row label="Monthly salary" value={formatCurrency(monthly)} />
      </section>

      <section className="grid grid-cols-2 gap-x-8 py-4">
        <div>
          <h2 className="border-b border-neutral-300 pb-1 text-xs font-bold uppercase tracking-wide">Earnings</h2>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {earnings.map((row) => (
                <tr key={row.label}>
                  <td className="py-1 text-neutral-700">{row.label}</td>
                  <td className="py-1 text-right tabular-nums">{formatCurrency(row.value)}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-semibold">
                <td className="py-1.5">Gross earnings</td>
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(gross)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <h2 className="border-b border-neutral-300 pb-1 text-xs font-bold uppercase tracking-wide">Deductions</h2>
          <table className="mt-2 w-full text-xs">
            <tbody>
              <tr>
                <td className="py-1 text-neutral-700">{slip.deductions > 0 ? slip.note || "Deductions" : "None"}</td>
                <td className="py-1 text-right tabular-nums">{formatCurrency(slip.deductions)}</td>
              </tr>
              <tr className="border-t border-neutral-300 font-semibold">
                <td className="py-1.5">Total deductions</td>
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(slip.deductions)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="border-y-2 border-neutral-800 py-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-bold uppercase tracking-wide">Net pay</span>
          <span className="text-lg font-bold tabular-nums">{formatCurrency(slip.net)}</span>
        </div>
        <p className="mt-1 text-xs text-neutral-600">{amountInWords(slip.net)}</p>
      </section>

      <p className="pt-4 text-[11px] text-neutral-500">Paid through the UAE Wages Protection System. This payslip is generated by the employer and needs no signature.</p>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-neutral-500">{label}</span>
      <span className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}
