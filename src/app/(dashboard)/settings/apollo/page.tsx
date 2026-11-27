import { isModuleEnabled } from "@/actions/module";
import { apolloSettings } from "@/actions/apollo";
import { enrichCredits } from "@/actions/enrich-credits";
import { EnrichCredits } from "@/components/settings/enrich-credits";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { ApolloSettings } from "@/components/settings/apollo-settings";
import { tenantOrigin } from "@/lib/tenancy/resolve";

export const metadata = { title: "Apollo" };

/**
 * Settings › Apollo (owner, 14 Nov 2026 — src/lib/apollo): the workspace's own Apollo.io API key. `settings.manage`
 * (the catalogue's gate) opens it, where Companies is on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  return (
    <SettingsPage
      settingsKey="apollo"
      description="Your Apollo.io account. Its API key lets people with the “Enrich from Apollo” permission fill a company's details, find a contact's email and mobile, and find people at a company. Every lookup spends your Apollo credits."
    >
      <Overview />
    </SettingsPage>
  );
}

async function Overview() {
  const [view, origin, credits] = await Promise.all([apolloSettings(), tenantOrigin(), enrichCredits("APOLLO")]);
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return (
    <div className="space-y-4">
      <ApolloSettings setup={view.data} origin={origin} />
      {credits.ok && <EnrichCredits provider="APOLLO" view={credits.data} />}
    </div>
  );
}
