import { isModuleEnabled } from "@/actions/module";
import { renewalSettingsView } from "@/actions/renewal-settings";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { RenewalSettings } from "@/components/settings/renewal-settings";
import { renewalReminderTemplate } from "@/actions/auto-notice-template";
import { RenewalReminderTemplate } from "@/components/settings/renewal-reminder-template";
import { db } from "@/lib/db";
import { PEOPLE_ONLY } from "@/lib/people";

export const metadata = { title: "Renewals" };

/**
 * Settings › Renewals (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts). `settings.manage` (the catalogue's gate)
 * opens it, where Renewals is on.
 */
export default async function Page() {
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  return (
    <SettingsPage settingsKey="renewals" description="Who is reminded before a subscription ends, who is told when nobody has started its renewal, and what happens when it isn't renewed.">
      <Overview />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Overview() {
  const [view, reminder] = await Promise.all([renewalSettingsView(), renewalReminderTemplate()]);
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  // Who may be chosen to hear about renewals nobody looks after: the people working here now.
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
  return (
    <>
      {reminder.ok && <RenewalReminderTemplate chosen={reminder.data.chosen} options={reminder.data.options} />}
      <RenewalSettings config={view.data} people={people} />
    </>
  );
}
