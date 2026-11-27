import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listJournalEntries } from "@/actions/ledger-reports";
import { listAccounts } from "@/actions/ledger";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { Database } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { JournalEntries } from "@/components/accounting/journal-entries";
import { NewJournalDialog } from "@/components/accounting/new-journal-dialog";
import { OpeningBalancesImport } from "@/components/accounting/opening-balances-import";
import { DateParamInput } from "@/components/accounting/date-param-input";
import { can } from "@/lib/authz/resolve";
import { listBranchChoices, listRegistrationChoices } from "@/lib/branches/identity";
import type { BranchChoice, RegistrationChoice } from "@/lib/branches/format";

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string; from?: string; to?: string; page?: string; pageSize?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;

  /**
   * The books are not a module-level read.
   *
   * Every statement on these pages is built from the same ledger, and the actions behind them
   * answered any signed-in session until this key existed. Without it the page is not found, like
   * any address the viewer shouldn't have.
   */
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "ledger.viewReports"))) notFound();

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [result, accounts] = await Promise.all([
    listJournalEntries({ page, pageSize, source: params.source, search: params.q, from: params.from, to: params.to }),
    listAccounts({ postableOnly: true }),
  ]);
  const isAdmin = await can(viewer.id, "ledger.post");
  // Opening balances from a file (owner, 18 Oct 2026): posting journals, and importing finance data.
  const canImportOpening = isAdmin && (await can(viewer.id, "data.importFinance"));
  // What a new entry's lines may be tagged with — only the dialog needs them, and only somebody who
  // may post sees it. Active ones only: a closed branch or a surrendered GSTIN takes no new lines.
  const [branches, registrations]: [BranchChoice[], RegistrationChoice[]] = isAdmin
    ? await Promise.all([listBranchChoices(), listRegistrationChoices().then((all) => all.filter((r) => r.active))])
    : [[], []];

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Journal"
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search entry number or narration" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<Database />}
              paramName="source"
              label="Source"
              allLabel="All"
              options={[
                { value: "INVOICE", label: "Invoice" },
                { value: "CREDIT_NOTE", label: "Credit note" },
                { value: "BILL", label: "Bill" },
                { value: "PAYMENT", label: "Payment" },
                { value: "EXPENSE", label: "Expense" },
                { value: "MANUAL", label: "Manual" },
                { value: "OPENING", label: "Opening" },
              ]}
            />
            <MoreFilters params={[["from", "to"]]}>
              <DateParamInput paramName="from" label="From" />
              <DateParamInput paramName="to" label="To" />
            </MoreFilters>
            <ClearFilters params={["q", "source", "from", "to"]} />
          </>
        }
        actions={
          <>
            {canImportOpening && <OpeningBalancesImport />}
            {isAdmin && <NewJournalDialog accounts={accounts} branches={branches} registrations={registrations} />}
          </>
        }
      />
      <p className="mt-1 text-sm text-muted">
        {result.total} entr{result.total === 1 ? "y" : "ies"} — every posting, in the order it was made. Nothing
        here is edited or deleted; a mistake is corrected by a reversal.
      </p>

      <div className="mt-5">
        <JournalEntries entries={result.rows} canReverse={isAdmin} />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
