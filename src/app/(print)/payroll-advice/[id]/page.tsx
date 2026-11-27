import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { statutoryFiles } from "@/actions/statutory-files";
import { getOrganisation } from "@/lib/organisation";
import { PrintButton } from "@/components/documents/print-button";
import { monthLabel } from "@/lib/hr/calendar";
import { formatCurrency } from "@/lib/utils";

/**
 * The salary advice letter to the bank for a locked payroll month (owner, 31 Oct 2026): who is paid what, to which
 * account, signed off by the company — the paper copy of the transfer file. People with no account on record are
 * left off here as in the file; the payroll month page lists them.
 */
export default async function PayrollAdvicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await isModuleEnabled("payroll"))) notFound();
  const [files, org] = await Promise.all([statutoryFiles(id), getOrganisation()]);
  if (!files || !files.ready) notFound();
  const month = monthLabel(files.run.month, files.run.year);
  const { content: lines, total } = files.bank;

  return (
    <div className="mx-auto max-w-3xl bg-white p-12 text-[13px] leading-relaxed text-neutral-900 shadow-sm print:p-0 print:shadow-none">
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>
      <p className="text-base font-semibold">{org.legalName || "—"}</p>
      <p className="mt-6">To,</p>
      <p>The Branch Manager</p>
      <p className="mt-4 font-medium">Subject: Salary for {month}</p>
      <p className="mt-3">
        Please transfer the salaries below for {month} from our account, {lines.length} payment(s) totalling{" "}
        <span className="font-medium">{formatCurrency(total)}</span>, to the accounts shown.
      </p>
      <table className="mt-5 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-neutral-400 text-left">
            <th className="py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Name</th>
            <th className="py-1.5 pr-2">Bank</th>
            <th className="py-1.5 pr-2">Account number</th>
            <th className="py-1.5 pr-2">IFSC</th>
            <th className="py-1.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-b border-neutral-200">
              <td className="py-1.5 pr-2">{i + 1}</td>
              <td className="py-1.5 pr-2">{l.name}</td>
              <td className="py-1.5 pr-2">{l.bankName ?? ""}</td>
              <td className="py-1.5 pr-2 font-mono">{l.accountNumber}</td>
              <td className="py-1.5 pr-2 font-mono">{l.ifsc}</td>
              <td className="py-1.5 text-right tabular-nums">{formatCurrency(l.amount)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td colSpan={5} className="py-2 pr-2 text-right">Total</td>
            <td className="py-2 text-right tabular-nums">{formatCurrency(total)}</td>
          </tr>
        </tbody>
      </table>
      <div className="print-keep mt-16">
        <p>For {org.legalName || "the company"}</p>
        <p className="mt-12">Authorised signatory</p>
      </div>
    </div>
  );
}
