import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getPrintTemplate } from "@/actions/print-template";
import { currentUser } from "@/lib/session";
import { previewDocumentFor } from "@/lib/documents/print-template-server";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { SettingsPage } from "@/components/settings/settings-page";
import { PrintTemplateEditor } from "@/components/settings/print-template-editor";
import { planGate } from "@/components/settings/module-disabled-notice";

export const metadata = { title: "Edit document template" };

/** One print template: its options on the left, the print page with them applied on the right. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const gate = await planGate(["sales_documents", "purchase_documents"], "Document templates");
  if (gate) return gate;
  const { id } = await params;
  // Null when it's gone, or for somebody who may not change templates — the 404 either way, as SettingsPage gives.
  const template = await getPrintTemplate(id);
  if (!template) notFound();
  const user = await currentUser();
  const preview = user ? await previewDocumentFor(user.id, template.docType) : null;

  return (
    <SettingsPage
      settingsKey="document-templates"
      title={template.name}
      description={`A ${tradeDocumentLabels[template.docType].toLowerCase()} template${template.isDefault ? " — the default, so every one prints with it unless another is picked" : ""}. The preview shows your changes as you make them; nothing changes on paper until you save.`}
    >
      <Link href="/settings/document-templates" className="-mt-2 inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ArrowLeft className="h-3.5 w-3.5" /> All document templates
      </Link>
      <PrintTemplateEditor template={template} preview={preview} />
    </SettingsPage>
  );
}
