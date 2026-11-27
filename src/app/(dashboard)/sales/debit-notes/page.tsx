import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { NOTES_PAGE } from "@/lib/modules";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { DocumentList, type DocumentListSearchParams } from "@/components/documents/document-list";

/** Debit notes (owner, 23 Oct 2026): what's added to an issued invoice after the fact. */
export default async function Page({ searchParams }: { searchParams: Promise<DocumentListSearchParams> }) {
  const enabled = await isModuleEnabled("sales_documents");
  if (!enabled) return <ModuleDisabledNotice moduleKey="sales_documents" />;
  // Accounts', not sales' (owner, 2 Nov 2026) — the menu link asks the same.
  if (!(await Promise.all(NOTES_PAGE.map((k) => viewerHas(k)))).some(Boolean)) notFound();

  return (
    <DocumentList
      docType="DEBIT_NOTE"
      title="Debit notes"
      description="Additions to an issued invoice — interest on late payment, a price revised upward, or something billed short."
      searchParams={await searchParams}
    />
  );
}
