import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getPayrollRun, payrollRunTotals } from "@/actions/payroll";
import { listDepartmentOptions } from "@/actions/department";
import { PayrollRegister } from "@/components/hr/payroll-register";
import { statutoryFiles } from "@/actions/statutory-files";
import { StatutoryFilesCard } from "@/components/hr/statutory-files-card";

export default async function PayrollRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ search?: string; departmentId?: string; sort?: string; flag?: string }>;
}) {
  const enabled = await isModuleEnabled("payroll");
  if (!enabled) return <ModuleDisabledNotice moduleKey="payroll" />;

  const [{ id }, filters] = await Promise.all([params, searchParams]);
  const [run, totals, departments, files] = await Promise.all([
    getPayrollRun(id, filters),
    payrollRunTotals(id),
    listDepartmentOptions(),
    statutoryFiles(id),
  ]);
  if (!run) notFound();

  return (
    <div className="animate-fade-rise space-y-4">
      <PayrollRegister run={run} totals={totals} departments={departments} />
      {files && <StatutoryFilesCard files={files} />}
    </div>
  );
}
