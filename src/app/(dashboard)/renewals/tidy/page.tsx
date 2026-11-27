import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { RenewalTidy } from "@/components/renewals/renewal-tidy";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Clean up old renewals" };

/**
 * Renewals › Clean up old renewals (owner, 31 Oct 2026 — src/lib/renewal-tidy.ts): subscriptions that ended long ago
 * and were never worked in Deskzo — most from the old CRM — linked to the order that renewed them, or closed.
 * Whoever changes the workspace's settings; anyone else finds no page here.
 */
export default async function RenewalTidyPage() {
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  if (!(await viewerHas("settings.manage"))) notFound();
  // Ninety days ago: what ended since is still somebody's to chase.
  const today = (await workspaceClock()).calendarDate(new Date());
  const defaultDay = new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Clean up old renewals</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Subscriptions that ended long ago and nobody worked here — most brought across from the old CRM — sit on the Renewals list as expired for
          ever. Usually they were renewed, as a later order that came across unlinked. This links each one to the customer&apos;s next order of the same
          product where there is one, and closes the rest as ended before Deskzo.
        </p>
      </div>
      <RenewalTidy defaultDay={defaultDay} />
    </div>
  );
}
