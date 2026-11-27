import Link from "next/link";
import { notFound } from "next/navigation";
import { ListFilter } from "lucide-react";
import { listCompanyOptions } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { listVerifiable } from "@/actions/verifiable";
import { VerifiableAdd, VerifiableTable, type CustomSetup } from "@/components/documents/verifiable-documents";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Button } from "@/components/ui/button";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { formSetup, listColumns, valuesOf } from "@/lib/custom-fields/server";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Certificates" };

/**
 * CRM › Certificates (owner, 7 Nov 2026 — src/actions/verifiable.ts): certificates, licences, warranties and letters this business
 * issues, each with a QR code and a public page saying whether it still stands.
 */
export default async function CertificatesPage({ searchParams }: { searchParams: Promise<{ q?: string; standing?: string } & CustomFilterParams> }) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const params = await searchParams;
  const customFilters = parseCustomFilters(params);
  const data = await listVerifiable({ q: params.q, standing: params.standing, customFilters });
  if (!data) notFound();
  const user = await requireUser();
  const ids = data.rows.map((r) => r.id);
  const [companies, canChange, canImport, customColumns, fieldFilters, blank, stored] = await Promise.all([
    data.mayIssue ? listCompanyOptions() : Promise.resolve([]),
    viewerHas("settings.manage"),
    viewerHas("data.importCrm"),
    listColumns("VERIFIABLE", user.id, ids, { listedOnly: true }),
    customFilterSetup("VERIFIABLE", user.id, customFilters),
    formSetup("VERIFIABLE", user.id),
    data.mayIssue ? valuesOf("VERIFIABLE", ids) : Promise.resolve(new Map()),
  ]);
  const customFor: Record<string, CustomSetup> = {};
  if (data.mayIssue && blank.fields.length > 0) {
    await Promise.all(ids.map(async (id) => void (customFor[id] = await formSetup("VERIFIABLE", user.id, stored.get(id) ?? {}))));
  }
  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Certificates"
        subtitle={`${data.rows.length} ${data.rows.length === 1 ? "certificate" : "certificates"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Number, who it's issued to, or what for" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="standing"
              label="Status"
              allLabel="Any"
              options={[
                { value: "VALID", label: "Valid" },
                { value: "EXPIRED", label: "Expired" },
                { value: "WITHDRAWN", label: "Withdrawn" },
              ]}
            />
            {fieldFilters.fields.length > 0 && <MoreFilters params={[]} fields={fieldFilters}>{null}</MoreFilters>}
            <ClearFilters params={["q", "standing"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            {canChange && (
              <Link href="/certificates/settings">
                <Button size="sm" variant="secondary">Public pages</Button>
              </Link>
            )}
            {data.mayIssue && canImport && (
              <Link href="/settings/data">
                <Button size="sm" variant="secondary">Import from Excel</Button>
              </Link>
            )}
            {data.mayIssue && <VerifiableAdd companies={companies} custom={blank} />}
          </>
        }
      />
      <p className="mt-2 text-sm text-muted">Each has a QR code to put on the document. Anybody who scans it sees whether it still stands, and withdrawing one changes that page at once.</p>
      <div className="mt-4">
        <VerifiableTable rows={data.rows} mayIssue={data.mayIssue} mayWithdraw={data.mayWithdraw} companies={companies} customColumns={customColumns} customFor={customFor} />
      </div>
    </div>
  );
}
