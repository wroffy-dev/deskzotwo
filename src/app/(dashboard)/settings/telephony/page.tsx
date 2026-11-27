import { isModuleEnabled } from "@/actions/module";
import { telephonyView } from "@/actions/telephony";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { TelephonySettings } from "@/components/settings/telephony-settings";

export const metadata = { title: "Cloud calling" };

/**
 * Settings › Cloud calling (owner, 26 Oct 2026 — src/lib/telephony). `settings.manage` (the catalogue's gate)
 * opens it, where Calls is on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("calls"))) return <ModuleDisabledNotice moduleKey="calls" />;
  return (
    <SettingsPage
      settingsKey="telephony"
      description="Your CallerDesk account: Call buttons ring through your business number, and every call on it — answered, missed, from customers on file or not — comes back to Calls."
    >
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const view = await telephonyView();
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return <TelephonySettings view={view.data} />;
}
