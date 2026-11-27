import { listMessageTemplates } from "@/actions/quick-messages";
import { SettingsPage } from "@/components/settings/settings-page";
import { MessageTemplatesSettings } from "@/components/settings/message-templates";

export const metadata = { title: "Message templates" };

/**
 * Settings → Message templates (owner, 11 Nov 2026 — src/lib/quick-messages): the ready-written emails and WhatsApp
 * messages people send customers by hand. `settings.manage` (the catalogue's gate) opens it.
 */
export default async function Page() {
  return (
    <SettingsPage
      settingsKey="message-templates"
      description="Ready-written emails and WhatsApp messages your team sends by hand — after a call, or to introduce a customer's new account manager. Nothing here goes on its own: a person picks one, reads it, and presses Send."
    >
      <Templates />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Templates() {
  const templates = await listMessageTemplates();
  if (!templates.ok) return <p className="text-sm text-danger">{templates.error}</p>;
  return <MessageTemplatesSettings templates={templates.data} />;
}
