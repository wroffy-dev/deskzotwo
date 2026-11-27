import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listSuppressions } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { SuppressionList } from "@/components/marketing/suppression-list";

export default async function SuppressionsPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const { search } = await searchParams;
  const user = await currentUser();
  const [rows, canManage] = await Promise.all([
    listSuppressions(search),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
  ]);

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Suppression list"
        search={<ToolbarSearch paramName="search" placeholder="Search" label="Address or domain" />}
        filters={<ClearFilters params={["search"]} />}
      />
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Only what somebody told us: an unsubscribe, a bounce, a spam complaint, or a decision made here. Everything
        else that stops a send — a reseller&apos;s customer, an unanswered complaint, an unverified address — is worked
        out fresh each time, so fixing the problem is enough on its own. A block added here stops marketing and
        reminders; to stop every email to somebody, invoices too, block them in{" "}
        <Link href="/settings/blocked-addresses" className="text-brand hover:underline">
          Settings › Blocked addresses
        </Link>
        .
      </p>

      <div className="mt-4">
        <SuppressionList rows={rows} canManage={canManage} />
      </div>
    </div>
  );
}
