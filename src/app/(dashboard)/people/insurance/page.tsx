import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { insurancePage } from "@/actions/insurance";
import { Card } from "@/components/ui/card";
import { MyCoverCard, PolicyCard, PolicyForm } from "@/components/hr/insurance";

export const metadata = { title: "Insurance" };

/** People › Insurance (owner, 31 Oct 2026 — src/actions/insurance.ts): my cover and family, and HR's policies. */
export default async function InsurancePage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { hr, mine, policies, people } = await insurancePage();
  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Insurance</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">The cover the company holds for you — your member number, who to call to claim, and the family on it.</p>
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">My cover</h2>
        {mine.length === 0 ? (
          <Card className="p-4 text-sm text-muted">You aren&apos;t on a company policy yet — HR adds people.</Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {mine.map((c) => (
              <MyCoverCard key={c.memberId} cover={c} />
            ))}
          </div>
        )}
      </section>
      {hr && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-text">Company policies</h2>
          <PolicyForm />
          {policies.map((p) => (
            <PolicyCard key={p.id} policy={p} people={people} />
          ))}
        </section>
      )}
    </div>
  );
}
