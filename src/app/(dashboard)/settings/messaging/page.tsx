import { getOrganisation } from "@/lib/organisation";
import { marketingWebhookSecret } from "@/lib/marketing/webhook-secret";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { listProviders } from "@/actions/messaging-provider";
import { SettingsPage } from "@/components/settings/settings-page";
import { MarketingManager } from "@/components/settings/marketing-manager";
import { UtmSettingsCard } from "@/components/settings/utm-settings-card";
import { utmSettings } from "@/lib/marketing/utm-settings";
import { SunsetSetting } from "@/components/settings/sunset-setting";
import { requireOptIn, sunsetDays } from "@/lib/marketing/policy";
import { OptInSetting } from "@/components/settings/opt-in-setting";
import { planGate } from "@/components/settings/module-disabled-notice";

export default async function Page() {
  // The providers are the marketing module's: campaigns are what they send.
  const gate = await planGate("marketing", "Mail & messaging");
  if (gate) return gate;
  const [organisation, providers, origin, webhookKey, utm, sunset, optIn] = await Promise.all([getOrganisation(), listProviders(), tenantOrigin(), marketingWebhookSecret(), utmSettings(), sunsetDays(), requireOptIn()]);
  // For the provider's delivery-report setting: this workspace's address, and its own secret.
  const webhookUrl = `${origin}/api/marketing/webhook/<provider>?key=${webhookKey}`;

  return (
    <SettingsPage
      title="Mail & messaging"
      description="The providers that actually send, the domain mail goes out from, and the hours it may go out in. Marketing is deliberately kept off the domain your invoices come from — a bad campaign should never be able to stop a purchase order arriving."
      settingsKey="messaging"
    >
      <div className="space-y-5">
        <MarketingManager organisation={organisation} providers={providers} webhookUrl={webhookUrl} />
        <UtmSettingsCard initial={utm} />
        <OptInSetting initial={optIn} />
        <SunsetSetting initial={sunset} />
      </div>
    </SettingsPage>
  );
}
