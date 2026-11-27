import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listPayrollRuns, myPayslips } from "@/actions/payroll";
import { Card } from "@/components/ui/card";
import { PayrollRuns } from "@/components/hr/payroll-runs";
import { MyPayslips } from "@/components/hr/my-payslips";
import { PayrollImport } from "@/components/hr/payroll-import";
import { KredilyImport } from "@/components/hr/kredily-import";
import { workspacePack } from "@/lib/country-pack";
import { myUaePayslips, uaePayroll } from "@/actions/uae-payroll";
import { UaePayroll } from "@/components/hr/uae-payroll";
import { formatCurrency } from "@/lib/utils";

export default async function PayrollPage() {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const caps = await hrCapabilities();
  // A UAE workspace's payroll is its own (owner, 15 Nov 2026 — src/lib/uae): AED pay, the WPS file, gratuity.
  if (workspacePack().country === "AE") return <UaePayrollPage manage={caps.payroll} />;
  const [runs, mine] = await Promise.all([listPayrollRuns(), myPayslips()]);

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Payroll</h1>
          <p className="mt-1 text-sm text-muted">
            {caps.payroll
              ? "PF, ESI, professional tax and income tax (TDS) are worked out from the Indian rules. TDS follows each person's tax declaration, and a figure you type on a payslip is kept."
              : "Your payslips. Only payroll can see anybody else's."}
          </p>
        </div>
        {/* Moving from another HRMS: salaries, bank and statutory numbers, pay so far (owner, 18 Oct 2026). */}
        {caps.payroll && (
          <div className="flex flex-wrap gap-2">
            {/* Moving off Kredily: its exports as they come (owner, 31 Oct 2026). */}
            <KredilyImport />
            <PayrollImport />
          </div>
        )}
      </div>

      {caps.payroll ? (
        <div className="mt-5 space-y-5">
          <PayrollRuns runs={runs} />
          {mine.length > 0 && <MyPayslips payslips={mine} />}
        </div>
      ) : (
        <div className="mt-5">
          {mine.length > 0 ? (
            <MyPayslips payslips={mine} />
          ) : (
            <Card className="px-4 py-12 text-center text-sm text-subtle">
              You have no payslips yet. They appear here once payroll locks the month.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

async function UaePayrollPage({ manage }: { manage: boolean }) {
  const [view, mine] = await Promise.all([manage ? uaePayroll() : Promise.resolve(null), myUaePayslips()]);
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Payroll</h1>
        <p className="mt-1 text-sm text-muted">
          {manage ? "Monthly pay in AED, the WPS salary file for your bank, end-of-service gratuity, UAE leave and document expiries." : "Your payslips. Only payroll can see anybody else's."}
        </p>
      </div>
      {view && (view.ok ? <UaePayroll view={view.data} /> : <p className="text-sm text-danger">{view.error}</p>)}
      {mine.length > 0 ? (
        <Card className="p-4 text-sm">
          <h2 className="mb-2 font-medium text-text">Your payslips</h2>
          <table className="w-full">
            <tbody>
              {mine.map((p) => (
                <tr key={p.id} className="border-t border-line first:border-0">
                  <td className="py-1.5 text-text">{p.label}</td>
                  <td className="py-1.5 text-muted">
                    Salary {formatCurrency(p.fixed)}
                    {p.overtime > 0 ? ` · overtime ${formatCurrency(p.overtime)}` : ""}
                    {p.bonus > 0 ? ` · bonus ${formatCurrency(p.bonus)}` : ""}
                    {p.unpaidDays > 0 ? ` · ${p.unpaidDays} unpaid days` : ""}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums text-text">{formatCurrency(p.net)}</td>
                  <td className="py-1.5 pl-3 text-right">
                    <a href={`/payslips/uae/${p.id}/print`} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
                      Payslip
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        !manage && <Card className="px-4 py-12 text-center text-sm text-subtle">You have no payslips yet. They appear here once payroll locks the month.</Card>
      )}
    </div>
  );
}
