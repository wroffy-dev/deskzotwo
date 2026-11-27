import Link from "next/link";
import { notFound } from "next/navigation";
import { listAssignableUsers, listCompanyOptions } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { startOptions } from "@/actions/service-cycles";
import { StartCycleForm } from "@/components/service-cycles/service-cycle-forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export const metadata = { title: "Start a service cycle" };

/** Starting a plan for a customer (owner, 9 Nov 2026). `?companyId=`, `?orderId=` and `?plan=` fill it in from where it was opened. */
export default async function StartServiceCyclePage({ searchParams }: { searchParams: Promise<{ companyId?: string; orderId?: string; plan?: string }> }) {
  if (!(await isModuleEnabled("tasks"))) return <ModuleDisabledNotice moduleKey="tasks" />;
  const params = await searchParams;
  const options = await startOptions();
  if (!options) notFound();
  const [companies, assignable] = await Promise.all([listCompanyOptions({ withContacts: false }), listAssignableUsers()]);
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/service-cycles?tab=cycles" className="text-xs text-brand hover:underline">Service cycles</Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Start a cycle</h1>
        <p className="mt-1 text-sm text-muted">The plan&apos;s timeline is made for this customer. Jobs already near become tasks straight away.</p>
      </div>
      <StartCycleForm
        templates={options.templates}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        people={assignable.map((p) => ({ id: p.id, name: p.name, email: p.email }))}
        preset={{ companyId: params.companyId, orderId: params.orderId, templateId: params.plan }}
      />
    </div>
  );
}
