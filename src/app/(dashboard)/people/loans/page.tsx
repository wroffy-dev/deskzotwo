import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { loansOverview } from "@/actions/loan";
import { LoansManager } from "@/components/hr/loans";

export const metadata = { title: "Loans & advances" };

/**
 * People › Loans & advances (owner, 31 Oct 2026): requests to decide, loans being recovered from pay, and new ones — for
 * whoever runs payroll (src/actions/loan.ts). Employees ask from My HR.
 */
export default async function LoansPage() {
  if (!(await isModuleEnabled("payroll"))) return <ModuleDisabledNotice moduleKey="payroll" />;
  const view = await loansOverview();
  if (!view) notFound();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/people/payroll" className="text-sm text-muted hover:text-text">
          ← Payroll
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">Loans &amp; advances</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Approved and paid out, each is recovered from the payslip month by month — never more than the pay can bear — or paid back by hand.
          Whatever is left when somebody leaves goes into their full and final.
        </p>
      </div>
      <LoansManager {...view} />
    </div>
  );
}
