import { isModuleEnabled } from "@/actions/module";
import { currenciesView } from "@/actions/currencies";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { CurrenciesManager } from "@/components/settings/currencies-manager";

export const metadata = { title: "Currencies" };

/**
 * Settings › Currencies (owner, 30 Oct 2026 — src/lib/finance/rates.ts). `payments.manage` (the catalogue's gate) opens
 * it, where sales or purchase documents are on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("sales_documents")) && !(await isModuleEnabled("purchase_documents"))) {
    return <ModuleDisabledNotice moduleKey="sales_documents" />;
  }
  return (
    <SettingsPage
      settingsKey="currencies"
      description="The exchange rates new documents in another currency start at: fetched once a day for the currencies your customers and vendors use, or typed in from your bank."
    >
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const view = await currenciesView();
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return <CurrenciesManager view={view.data} />;
}
