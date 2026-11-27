import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getLookalikes } from "@/actions/prospects";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Lookalikes } from "@/components/leads/lookalikes";

export const metadata = { title: "Find lookalikes" };
export const dynamic = "force-dynamic";

/**
 * Leads › Find lookalikes (owner, 22 Nov 2026 — src/lib/prospects): Ved reads what your best customers have in common and
 * finds people like their buyers, at companies like theirs, in Apollo. Refused (404) without the right to add leads and
 * spend Apollo credits.
 */
export default async function LookalikesPage() {
  if (!(await isModuleEnabled("leads"))) return <ModuleDisabledNotice moduleKey="leads" />;
  const data = await getLookalikes();
  if (!data) notFound();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/leads" className="text-xs text-brand hover:underline">
          Leads
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Find lookalikes</h1>
      </div>
      <Lookalikes data={data} />
    </div>
  );
}
