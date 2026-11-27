import { notFound } from "next/navigation";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { hrDeskConfig, hrInbox } from "@/lib/hr-desk/server";
import { HrDeskInbox } from "@/components/hr/hr-desk-inbox";

export const metadata = { title: "HR desk" };
export const dynamic = "force-dynamic";

/**
 * People › HR desk (owner, 20 Nov 2026 — src/lib/hr-desk): the questions Priya passed to HR, for whoever manages people
 * records. A refused page is a 404, as everywhere.
 */
export default async function HrDeskPage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const user = await requireModuleUser("hr");
  if (!(await can(user.id, "hr.manage"))) notFound();
  const [config, items] = await Promise.all([hrDeskConfig(), hrInbox()]);
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">HR desk</h1>
        <p className="mt-1 text-sm text-muted">
          Questions Priya couldn&apos;t answer — or where somebody asked for a person. Your answer appears under their question on My HR, and they&apos;re told.
          {!config.enabled && (
            <>
              {" "}
              The HR desk is switched off;{" "}
              <Link href="/settings/copilot" className="text-brand hover:underline">
                switch it on in Settings › Deskzo AI
              </Link>
              .
            </>
          )}
        </p>
      </div>
      <HrDeskInbox items={items} />
    </div>
  );
}
