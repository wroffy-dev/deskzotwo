import { isModuleEnabled } from "@/actions/module";
import { loyaltySettingsView } from "@/actions/customer-loyalty";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { CustomerLoyaltySettings } from "@/components/settings/customer-loyalty-settings";

export const metadata = { title: "Customer loyalty" };

/**
 * Settings › Customer loyalty (owner, 31 Oct 2026 — src/lib/customers/loyalty-rules.ts). `settings.manage` (the
 * catalogue's gate) opens it, where Companies is on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  return (
    <SettingsPage
      settingsKey="customer-loyalty"
      description="How each customer's history with you becomes a tier — New, Champion, Loyal, Growing, At risk or Lapsed — shown as a badge on Customers and on each customer's page."
    >
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const view = await loyaltySettingsView();
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return <CustomerLoyaltySettings view={view.data} />;
}
