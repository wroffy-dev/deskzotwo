import { listPrintTemplates } from "@/actions/print-template";
import { SettingsPage } from "@/components/settings/settings-page";
import { PrintTemplatesManager } from "@/components/settings/print-templates-manager";
import { planGate } from "@/components/settings/module-disabled-notice";

export const metadata = { title: "Document templates" };

export default async function Page() {
  const gate = await planGate(["sales_documents", "purchase_documents"], "Document templates");
  if (gate) return gate;
  // Null for somebody who may not change them — whom SettingsPage turns away before anything shows.
  const templates = (await listPrintTemplates()) ?? [];

  return (
    <SettingsPage
      settingsKey="document-templates"
      description="How each kind of document looks on paper. A kind can have several templates: the default is what it prints, emails and previews with, and any other can be picked when printing. A document keeps nothing of a template — reprinting it uses whichever is chosen then."
    >
      <PrintTemplatesManager templates={templates} />
    </SettingsPage>
  );
}
