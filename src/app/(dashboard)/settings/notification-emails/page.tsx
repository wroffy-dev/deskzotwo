import { isModuleEnabled } from "@/actions/module";
import { notificationEmailChoices, notificationEmailTemplates } from "@/actions/notification";
import { requireUser } from "@/lib/session";
import { currentTenant } from "@/lib/tenancy/resolve";
import { db } from "@/lib/db";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { NotificationEmailSettings, type NotificationSender } from "@/components/settings/notification-email-settings";
import { emailRouteFor } from "@/lib/marketing/pipeline";

export const metadata = { title: "Email notifications" };

/**
 * Settings → Email notifications (owner, 18 Oct 2026) — src/lib/notifications/email-settings.ts.
 * `settings.manage` and the notifications module (the catalogue's gate) open it.
 */
export default async function Page() {
  if (!(await isModuleEnabled("notifications"))) return <ModuleDisabledNotice moduleKey="notifications" />;
  return (
    <SettingsPage
      settingsKey="notification-emails"
      description="Which notifications go to people's inboxes as well as their bell. The choice is the same for everyone, and a person can't switch an email off for themselves."
    >
      <Choices />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Choices() {
  const [choices, route, templates, me, org, tenant] = await Promise.all([
    notificationEmailChoices(),
    emailRouteFor("TRANSACTIONAL"),
    notificationEmailTemplates(),
    requireUser(),
    db.organisationSettings.findUnique({ where: { id: "global" }, select: { tradeName: true, legalName: true } }).catch(() => null),
    currentTenant(),
  ]);
  if (!choices.ok) return <p className="text-sm text-danger">{choices.error}</p>;
  const sender: NotificationSender = route ? { via: "COMPANY", from: route.fromEmail ?? route.label } : { via: "DESKZO" };
  // The company's name as the emails show it (src/lib/email.ts companyName), for the previews.
  const company = org?.tradeName?.trim() || org?.legalName.trim() || tenant.name;
  return <NotificationEmailSettings choices={choices.data} sender={sender} templates={templates.ok ? templates.data : null} company={company} you={me.name ?? "Your name"} />;
}
