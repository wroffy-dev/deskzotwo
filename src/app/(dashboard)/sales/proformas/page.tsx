import { workspacePack } from "@/lib/country-pack";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;

  return (
    <DocumentList
      docType="PROFORMA"
      title="Proforma invoices"
      description={
        workspacePack().india
          ? "Payment requests raised before supply. Not a tax invoice — no IRN is generated for these."
          : "Payment requests raised before supply. Not a tax invoice."
      }
      searchParams={await searchParams}
    />
  );
}
