import { listFieldRules } from "@/actions/field-rules";
import { SettingsPage } from "@/components/settings/settings-page";
import { FieldRulesSettings } from "@/components/settings/field-rules";

export const metadata = { title: "Field rules" };

/**
 * Settings → Field rules (owner, 12 Nov 2026 — src/lib/field-rules): what must be filled in, and in what form, on a
 * company, a contact or a lead. `settings.manage` (the catalogue's gate) opens it.
 */
export default async function Page() {
  return (
    <SettingsPage
      settingsKey="field-rules"
      description="Make any field compulsory, or hold it to a length, a format, a range, or to no two the same — always, or only when another field says so. Checked whenever somebody saves: the forms, the phone app, the API and imports."
    >
      <Rules />
    </SettingsPage>
  );
}

/** Read only once the page's gate has let the person in. */
async function Rules() {
  const view = await listFieldRules();
  if (!view.ok) return <p className="text-sm text-danger">{view.error}</p>;
  return <FieldRulesSettings view={view.data} />;
}
