import { listMailBlocks } from "@/actions/mail-blocks";
import { SettingsPage } from "@/components/settings/settings-page";
import { MailBlocks } from "@/components/settings/mail-blocks";

export const metadata = { title: "Blocked addresses" };

/**
 * Settings › Blocked addresses (owner, 31 Oct 2026) — src/lib/mail-blocks.ts. `settings.manage` (the catalogue's gate)
 * opens it, in every plan: it covers every email the workspace sends, not only marketing's.
 */
export default async function Page() {
  return (
    <SettingsPage
      settingsKey="blocked-addresses"
      description="Addresses and whole domains this workspace never mails. Block all mail — invoices and documents too — or only marketing and reminders. Checked as each email leaves, whoever sends it and however."
    >
      <List />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function List() {
  const blocks = await listMailBlocks();
  if (!blocks.ok) return <p className="text-sm text-danger">{blocks.error}</p>;
  return <MailBlocks rows={blocks.data.rows} allMailReady={blocks.data.allMailReady} />;
}
